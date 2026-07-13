import { afterEach, describe, expect, it, vi } from "vitest";
import { streamCoachTurn, type CoachEvent } from "./coach";
import { collect, fakeHevy, makeCtx, scriptedModel } from "./testFixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

function textOf(events: CoachEvent[]): string {
  return events.filter((e) => e.type === "text").map((e) => (e as Any).text).join("");
}
function toolEvents(events: CoachEvent[]) {
  return {
    starts: events.filter((e) => e.type === "tool_start") as Any[],
    ends: events.filter((e) => e.type === "tool_end") as Any[],
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("offline fallback", () => {
  it("answers deterministically from the engine when no key and no client", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    const { ctx } = makeCtx();
    const events = await collect(streamCoachTurn({ turns: [{ role: "user", content: "How's my week?" }], ctx }));
    expect(events.at(-1)).toEqual({ type: "done" });
    const text = textOf(events);
    expect(text).toContain("Offline coach");
    expect(text).toContain("working sets");
  });
});

describe("request construction", () => {
  it("streams text, ends cleanly, and builds a cacheable tool-carrying request", async () => {
    const { ctx } = makeCtx();
    const { client, requests } = scriptedModel([{ text: "Your week looks solid." }]);
    const events = await collect(
      streamCoachTurn({ turns: [{ role: "user", content: "Review my week." }], ctx, client }),
    );

    expect(textOf(events)).toBe("Your week looks solid.");
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.some((e) => e.type === "error")).toBe(false);

    expect(requests).toHaveLength(1);
    const req = requests[0] as Any;
    expect(req.model).toBe("claude-opus-4-8");
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.max_tokens).toBeGreaterThanOrEqual(8192);
    // Static system block first with a cache breakpoint; dynamic context second.
    expect(req.system).toHaveLength(2);
    expect(req.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(req.system[0].text).toContain("Training Coach");
    expect(req.system[1].text).toContain("Athlete context");
    expect(req.system[1].text).toContain("Today is Saturday 2026-07-11");
    expect(req.system[1].text).toContain('day-a ("Full Body A")');
    // The full tool surface rides along.
    const toolNames = req.tools.map((t: Any) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["get_schedule", "get_day_prescriptions", "update_program", "push_to_hevy", "log_session"]),
    );
    expect(req.messages).toEqual([{ role: "user", content: "Review my week." }]);
  });

  it("threads multi-turn history into the request", async () => {
    const { ctx } = makeCtx();
    const { client, requests } = scriptedModel([{ text: "ok" }]);
    await collect(
      streamCoachTurn({
        turns: [
          { role: "user", content: "Plan my week." },
          { role: "assistant", content: "Here's the plan…" },
          { role: "user", content: "Now push it to Hevy." },
        ],
        ctx,
        client,
      }),
    );
    const messages = (requests[0] as Any).messages;
    expect(messages.map((m: Any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[2].content).toBe("Now push it to Hevy.");
  });

  it("keeps the system context byte-identical across iterations (cache-friendly)", async () => {
    const { ctx } = makeCtx();
    const { client, requests } = scriptedModel([
      { toolCalls: [{ name: "get_week_volume", input: {} }] },
      { text: "done" },
    ]);
    await collect(streamCoachTurn({ turns: [{ role: "user", content: "Check volume" }], ctx, client }));
    expect(requests).toHaveLength(2);
    expect((requests[1] as Any).system).toEqual((requests[0] as Any).system);
    expect((requests[1] as Any).tools).toEqual((requests[0] as Any).tools);
  });
});

describe("tool round-trips", () => {
  it("executes a tool call and feeds the result back with the matching id", async () => {
    const { ctx } = makeCtx();
    const { client, requests } = scriptedModel([
      { text: "Checking volume.", toolCalls: [{ id: "toolu_vol", name: "get_week_volume", input: {} }] },
      { text: "Sixteen sets on the week." },
    ]);
    const events = await collect(streamCoachTurn({ turns: [{ role: "user", content: "Volume?" }], ctx, client }));

    const { starts, ends } = toolEvents(events);
    expect(starts).toHaveLength(1);
    expect(starts[0].name).toBe("get_week_volume");
    expect(starts[0].label).toContain("volume");
    expect(ends[0].ok).toBe(true);

    const second = requests[1] as Any;
    // [user, assistant(text + tool_use), user(tool_result)]
    expect(second.messages.map((m: Any) => m.role)).toEqual(["user", "assistant", "user"]);
    const assistantContent = second.messages[1].content;
    expect(assistantContent.some((b: Any) => b.type === "tool_use" && b.id === "toolu_vol")).toBe(true);
    const results = second.messages[2].content;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_vol" });
    const payload = JSON.parse(results[0].content);
    expect(payload.totalSets).toBe(16);
    expect(results[0].is_error).toBeUndefined();

    expect(textOf(events)).toBe("Checking volume.Sixteen sets on the week.");
  });

  it("returns ALL parallel tool results in one user message, order preserved", async () => {
    const { ctx } = makeCtx();
    const { client, requests } = scriptedModel([
      {
        toolCalls: [
          { id: "toolu_a", name: "get_day_prescriptions", input: { dayId: "day-a" } },
          { id: "toolu_b", name: "get_day_prescriptions", input: { dayId: "day-b" } },
        ],
      },
      { text: "Both days read." },
    ]);
    const events = await collect(streamCoachTurn({ turns: [{ role: "user", content: "Read both days" }], ctx, client }));

    const { starts, ends } = toolEvents(events);
    expect(starts).toHaveLength(2);
    expect(ends.every((e) => e.ok)).toBe(true);

    const second = requests[1] as Any;
    expect(second.messages).toHaveLength(3); // one user message carries both results
    const results = second.messages[2].content;
    expect(results.map((r: Any) => r.tool_use_id)).toEqual(["toolu_a", "toolu_b"]);
    expect(JSON.parse(results[0].content).dayId).toBe("day-a");
    expect(JSON.parse(results[1].content).dayId).toBe("day-b");
  });

  it("marks failed tools with is_error and keeps the loop alive", async () => {
    const { ctx } = makeCtx();
    const { client, requests } = scriptedModel([
      { toolCalls: [{ id: "toolu_bad", name: "get_day_prescriptions", input: { dayId: "ghost" } }] },
      { text: "That day doesn't exist — you have day-a and day-b." },
    ]);
    const events = await collect(streamCoachTurn({ turns: [{ role: "user", content: "Read day ghost" }], ctx, client }));

    const { ends } = toolEvents(events);
    expect(ends[0].ok).toBe(false);
    expect(ends[0].summary).toContain("Unknown dayId");

    const results = (requests[1] as Any).messages[2].content;
    expect(results[0].is_error).toBe(true);
    expect(JSON.parse(results[0].content).error).toContain("day-a");
    expect(textOf(events)).toContain("day-a and day-b");
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("recovers from a completely unknown tool name", async () => {
    const { ctx } = makeCtx();
    const { client } = scriptedModel([
      { toolCalls: [{ name: "teleport_to_gym", input: {} }] },
      { text: "Sorry, I used a nonexistent tool." },
    ]);
    const events = await collect(streamCoachTurn({ turns: [{ role: "user", content: "hi" }], ctx, client }));
    const { ends } = toolEvents(events);
    expect(ends[0].ok).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("stops at the iteration cap with an explanatory error event", async () => {
    const { ctx } = makeCtx();
    const { client, requests } = scriptedModel(
      Array.from({ length: 10 }, () => ({ toolCalls: [{ name: "get_week_volume", input: {} }] })),
    );
    const events = await collect(
      streamCoachTurn({ turns: [{ role: "user", content: "loop forever" }], ctx, client, maxIterations: 3 }),
    );
    expect(requests).toHaveLength(3);
    const error = events.find((e) => e.type === "error") as Any;
    expect(error.message).toContain("tool budget");
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("surfaces model API failures as an error event, not a crash", async () => {
    const { ctx } = makeCtx();
    const client = {
      stream() {
        throw new Error("529 overloaded");
      },
    };
    const events = await collect(streamCoachTurn({ turns: [{ role: "user", content: "hi" }], ctx, client }));
    expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("overloaded") });
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});

describe("flagship scenario: back-to-back days, adjust both, push to Hevy", () => {
  it("schedule → read both days → restructure → dry-run → push → summary", async () => {
    const hevy = fakeHevy({
      routines: [
        { id: "ra", title: "W1 Full Body A [day-a]", folder_id: 9 },
        { id: "rb", title: "W1 Full Body B [day-b]", folder_id: 9 },
      ],
    });
    const { ctx, store } = makeCtx({ hevy });

    const pushInput = {
      dayIds: ["day-a", "day-b"],
      datesByDayId: { "day-a": "2026-07-12", "day-b": "2026-07-13" },
      mode: "update",
    };
    const { client, requests } = scriptedModel([
      { text: "Let me check your schedule first. ", toolCalls: [{ name: "get_schedule", input: {} }] },
      {
        toolCalls: [
          { name: "get_day_prescriptions", input: { dayId: "day-a" } },
          { name: "get_day_prescriptions", input: { dayId: "day-b" } },
        ],
      },
      {
        text: "Backing off the compounds so the days stack. ",
        toolCalls: [
          {
            name: "update_program",
            input: {
              edits: [
                { op: "update_exercise", exerciseId: "squat-1", set: { rir: 3 } },
                { op: "update_exercise", exerciseId: "bench-4", set: { rir: 3 } },
                { op: "move_exercise", exerciseId: "pushdown-6", toDayId: "day-a", position: 2 },
              ],
            },
          },
        ],
      },
      { toolCalls: [{ name: "push_to_hevy", input: { ...pushInput, push: false } }] },
      { toolCalls: [{ name: "push_to_hevy", input: { ...pushInput, push: true } }] },
      { text: "Done — Sunday is Full Body A and Monday is Full Body B, both eased to 3 RIR. Pushed both routines to Hevy." },
    ]);

    const events = await collect(
      streamCoachTurn({
        turns: [
          {
            role: "user",
            content:
              "I'm training tomorrow (Sunday) and also Monday, back to back, full body both days. Adjust tomorrow's workout and the day after so they stack sensibly, then push the final versions to Hevy.",
          },
        ],
        ctx,
        client,
      }),
    );

    // 1. The loop ran the full six-step script.
    expect(requests).toHaveLength(6);
    const { starts, ends } = toolEvents(events);
    expect(starts.map((s) => s.name)).toEqual([
      "get_schedule",
      "get_day_prescriptions",
      "get_day_prescriptions",
      "update_program",
      "push_to_hevy",
      "push_to_hevy",
    ]);
    expect(ends.every((e) => e.ok)).toBe(true);

    // 2. The plan actually changed in the store.
    const squat = store.program.days[0].exercises.find((e) => e.id === "squat-1")!;
    const bench = store.program.days[1].exercises.find((e) => e.id === "bench-4")!;
    expect(squat.wave.rirStart).toBe(3);
    expect(bench.wave.rirStart).toBe(3);
    expect(store.program.days[0].exercises.map((e) => e.id)).toContain("pushdown-6");
    expect(store.program.days[1].exercises.map((e) => e.id)).not.toContain("pushdown-6");

    // 3. Dry run wrote nothing; the real push PUT exactly the two marker-matched routines.
    const dryRunResult = JSON.parse(((requests[4] as Any).messages.at(-1).content[0] as Any).content);
    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.routines.map((r: Any) => r.title)).toEqual([
      "W2 Full Body A (Sun 07-12) [day-a]",
      "W2 Full Body B (Mon 07-13) [day-b]",
    ]);
    const puts = hevy.writes().filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2); // only the push:true call wrote
    expect(puts.map((c) => c.path).sort()).toEqual(["/v1/routines/ra", "/v1/routines/rb"]);
    const pushedA = (puts.find((c) => c.path.endsWith("ra"))!.body as Any).routine;
    expect(pushedA.title).toBe("W2 Full Body A (Sun 07-12) [day-a]");
    // The restructure is reflected in what went to Hevy: pushdown now on day A…
    expect(pushedA.exercises.map((e: Any) => e.exercise_template_id)).toContain("tmpl-pushdown");
    // …and day B no longer has it.
    const pushedB = (puts.find((c) => c.path.endsWith("rb"))!.body as Any).routine;
    expect(pushedB.exercises.map((e: Any) => e.exercise_template_id)).not.toContain("tmpl-pushdown");

    // 4. The push result the model saw confirms the writes.
    const pushResult = JSON.parse(((requests[5] as Any).messages.at(-1).content[0] as Any).content);
    expect(pushResult.pushed).toBe(true);
    expect(pushResult.written.updated).toHaveLength(2);

    // 5. The athlete gets a final summary and a clean done.
    expect(textOf(events)).toContain("Pushed both routines to Hevy");
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
