import Anthropic from "@anthropic-ai/sdk";
import { buildCalendar } from "../engine/calendar";
import { planningCheck } from "../engine/analysis";
import { buildCoachContext } from "./context";
import {
  COACH_TOOL_DEFINITIONS,
  defaultCoachContext,
  describeToolCall,
  runCoachTool,
  summarizeOutcome,
  type CoachToolContext,
} from "./tools";

const MODEL = "claude-opus-4-8";
/** Assistant⇄tool round-trips per user turn. Generous: one round can carry many calls. */
const MAX_ITERATIONS = 12;

export function hasCoachKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/* ------------------------------------------------------------------- types */

export interface CoachTurn {
  role: "user" | "assistant";
  content: string;
}

/** What the coach streams to the UI, one NDJSON line per event. */
export type CoachEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; label: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string }
  | { type: "error"; message: string }
  | { type: "done" };

/* --------------------------------------------------------- model interface
 * Minimal structural interface over `client.messages.stream(...)` so tests can
 * inject a scripted model. The real adapter wraps the Anthropic SDK.
 * ------------------------------------------------------------------------ */

export interface CoachModelMessage {
  content: unknown[];
  stop_reason: string | null;
}

export interface CoachModelStream extends AsyncIterable<unknown> {
  finalMessage(): Promise<CoachModelMessage>;
}

export interface CoachModelClient {
  stream(params: Record<string, unknown>): CoachModelStream;
}

function anthropicModelClient(): CoachModelClient {
  const client = new Anthropic();
  return {
    stream(params) {
      // Adaptive thinking + `effort` are valid on Opus 4.8 but ahead of this SDK
      // version's static types, so the params object is typed loosely.
      return client.messages.stream(params as unknown as Anthropic.MessageStreamParams);
    },
  };
}

/* ------------------------------------------------------------ system prompt */

export const COACH_SYSTEM = `You are the Training Coach inside a progressive-overload, periodized strength-training app. The athlete's program lives in this app (the source of truth) and is mirrored to their Hevy account as routines; they train from Hevy and their real workout history lives there.

# Grounding
An "Athlete context" snapshot (program, this week's prescriptions, volume analysis, recent logs, evidence base) is provided each turn. It reflects the state at the START of the turn — after you edit anything, trust your tool results over the snapshot. Never invent numbers that aren't in the data; if something is missing, fetch it with a tool or say so.

# Tools — when to reach for them
- Any mention of days or dates ("tomorrow", "Sunday", "back to back", "next week") → get_schedule FIRST, and anchor date math to it.
- What actually happened in the gym (including sessions never logged here) → get_hevy_workouts. In-app decisions → get_recent_logs.
- Concrete numbers for one day → get_day_prescriptions. Per-muscle weekly dose → get_week_volume. Long-range trends → get_progress_snapshot.
- "Refresh", "sync", or "pull from Hevy" → call the relevant Hevy read tools immediately. They read live with the server-owned connection; never ask the athlete for an API key.
- Plan changes → get_program (for ids), then update_program, then verify with get_week_volume.
- Mirroring to Hevy → list_hevy_routines to see what exists, push_to_hevy to write.

# Making changes
- update_program edits the local plan only; Hevy is untouched until push_to_hevy. Edits persist into future weeks (the sets/reps/rir shorthands flatten that dimension of the wave — use the nested wave object to keep waving).
- Programming judgment for restructures (e.g. two full-body days back to back): manage interference — avoid stacking maximal squat and deadlift on consecutive days; bias day 1 vs day 2 toward different emphases (push/pull, or heavy/volume); keep weekly per-muscle volume inside MEV–MRV and verify it; always preserve the marked warm-up ramps before big compounds (warm-ups never count as working volume).
- Consent: propose the exact change and get the athlete's OK before writing. EXCEPTION — when their message already authorizes the action ("adjust tomorrow's workout … then push to Hevy"), don't re-ask: edit, dry-run the push, verify the routines, then push and report exactly what was written.
- push_to_hevy: ALWAYS run with push:false first and check the routine lines, even when pre-authorized. Then push:true. Use dayIds to touch only the days in question and datesByDayId to stamp planned dates into the titles. Default mode "update" overwrites the existing routine for each day (matched by its [day-id] marker) — that is the normal weekly flow.
- If the program is locked, update_program fails: unlock with set_program_lock only when the athlete wants the edits, and offer to re-lock after.
- If a tool errors, read the error, fix your input or explain the blocker — don't silently retry forever.
- If the server-side Hevy connection is unavailable, say the connection is unavailable and continue with local plan data. Never ask the athlete to paste or manage the integration key.

# Style
- Lead with the answer, then the reasoning. Concise, direct, quantitative — cite actual loads, sets, RIR (e.g. 225lb × 5 × 3 @ 2 RIR).
- Light markdown only: **bold**, bullet lists, short headings.
- You are a training assistant, not a medical professional — for pain, injury, or medical questions, recommend a qualified professional.`;

/* ----------------------------------------------------------- main generator */

export interface CoachStreamOptions {
  turns: CoachTurn[];
  ctx?: CoachToolContext;
  client?: CoachModelClient;
  maxIterations?: number;
  signal?: AbortSignal;
}

/**
 * Run one coach turn: stream text, execute tool calls (schedule reads, program
 * edits, Hevy pushes, …), loop until the model finishes, yielding UI events.
 * Falls back to a deterministic, engine-derived answer when no API key is set.
 */
export async function* streamCoachTurn(opts: CoachStreamOptions): AsyncGenerator<CoachEvent> {
  const ctx = opts.ctx ?? defaultCoachContext();
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;

  if (!opts.client && !hasCoachKey()) {
    yield { type: "text", text: await deterministicAnswer(opts.turns, ctx) };
    yield { type: "done" };
    return;
  }

  const client = opts.client ?? anthropicModelClient();

  try {
    const context = await buildSituationContext(ctx);
    const messages: Array<Record<string, unknown>> = opts.turns.map((t) => ({
      role: t.role,
      content: t.content,
    }));

    let toolSeq = 0;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (opts.signal?.aborted) break;

      const stream = client.stream({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        system: [
          // Static block first — cacheable prefix (tools render before system).
          { type: "text", text: COACH_SYSTEM, cache_control: { type: "ephemeral" } },
          { type: "text", text: `# Athlete context\n\n${context}` },
        ],
        tools: COACH_TOOL_DEFINITIONS,
        messages,
      });

      for await (const raw of stream) {
        const event = raw as { type?: string; delta?: { type?: string; text?: string } };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          yield { type: "text", text: event.delta.text };
        }
      }

      const message = await stream.finalMessage();
      messages.push({ role: "assistant", content: message.content });

      // Server-side pause (not expected with client tools, but resume correctly).
      if (message.stop_reason === "pause_turn") continue;

      const toolUses = message.content.filter(
        (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
          (b as { type?: string }).type === "tool_use",
      );
      if (toolUses.length === 0 || message.stop_reason !== "tool_use") {
        yield { type: "done" };
        return;
      }

      // Execute sequentially (write tools must not race), then return ALL
      // results in a single user message, ids matched to the tool_use blocks.
      const results: Array<Record<string, unknown>> = [];
      for (const call of toolUses) {
        const chipId = `t${++toolSeq}`;
        yield { type: "tool_start", id: chipId, name: call.name, label: describeToolCall(call.name, call.input) };
        const outcome = await runCoachTool(call.name, call.input, ctx);
        yield {
          type: "tool_end",
          id: chipId,
          name: call.name,
          ok: !outcome.isError,
          summary: summarizeOutcome(call.name, outcome),
        };
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(outcome.result),
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: results });
    }

    yield {
      type: "error",
      message: "The coach hit its tool budget for this message. Ask it to continue to pick up where it left off.",
    };
    yield { type: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "coach error";
    yield { type: "error", message };
    yield { type: "done" };
  }
}

/* ---------------------------------------------------------------- context */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function buildSituationContext(ctx: CoachToolContext): Promise<string> {
  const [program, logs, state] = await Promise.all([
    ctx.store.getProgram(),
    ctx.store.getLogs(),
    ctx.getBlockState(),
  ]);
  const calendar = buildCalendar(program.cycle);
  const week = Math.min(Math.max(1, state.currentWeek), calendar.length);
  const wk = calendar.find((w) => w.week === week) ?? calendar[0];
  const now = ctx.now();
  const today = now.toISOString().slice(0, 10);
  const header = [
    `Today is ${WEEKDAYS[new Date(`${today}T00:00:00Z`).getUTCDay()]} ${today} (UTC).`,
    `Active block: "${state.block}" — week ${week}/${calendar.length} (${wk.label}${wk.isDeload ? ", DELOAD" : ""}), started ${state.startDate}.`,
    `Program locked: ${program.locked ? "yes" : "no"}. Default training days: Mon/Thu/Sat (athlete may deviate — trust their message).`,
    `Day ids: ${program.days.map((d) => `${d.id} ("${d.name}")`).join(", ")}.`,
  ].join("\n");
  return `${header}\n\n${buildCoachContext(program, logs, week)}`;
}

/**
 * Deterministic, engine-derived answer used when no LLM key is present.
 * Proves the grounding (program + logs + volume) is real even without a model.
 */
async function deterministicAnswer(turns: CoachTurn[], ctx: CoachToolContext): Promise<string> {
  const [program, state] = await Promise.all([ctx.store.getProgram(), ctx.getBlockState()]);
  const calendar = buildCalendar(program.cycle);
  const week = Math.min(Math.max(1, state.currentWeek), calendar.length);
  const check = planningCheck(program, week);
  const flags = check.byMuscle.filter((m) => m.verdict === "under" || m.verdict === "over");
  const out: string[] = [];
  out.push(
    `**(Offline coach — set ANTHROPIC_API_KEY to enable the conversational coach with tools: plan edits, Hevy reads, and routine pushes. Here's a deterministic read of your data.)**`,
  );
  out.push("");
  out.push(`**This week (${state.block} W${week}):** ${check.totalSets} working sets / ${check.totalReps} reps.`);
  if (flags.length) {
    out.push(`**Worth watching:**`);
    for (const m of flags)
      out.push(
        `- ${m.muscle}: ${m.sets} sets is ${m.verdict === "under" ? "below MEV" : "above MRV"} (MEV ${m.landmark.mev}, MRV ${m.landmark.mrv}).`,
      );
  } else {
    out.push(`**Volume:** every muscle group is inside its productive range (MEV–MRV). Nothing flagged.`);
  }
  out.push("");
  out.push(
    `**Top muscle shares:** ${check.byMuscle
      .slice(0, 3)
      .map((m) => `${m.muscle} ${Math.round(m.share * 100)}%`)
      .join(", ")}.`,
  );
  return out.join("\n");
}
