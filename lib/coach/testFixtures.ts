/**
 * Shared fixtures for the coach harness tests: an in-memory Store, a
 * deterministic two-day program, a fake Hevy API (records every write), a
 * frozen clock, and a scripted model client for driving the agent loop.
 * Imported only by *.test.ts files.
 */
import type { Exercise, Program, WaveConfig } from "../engine/types";
import { coachThreadTitle, type CoachMessage, type CoachThread, type SessionLog, type Store } from "../store/types";
import type { BlockState } from "../store/blockState";
import type { HevyExerciseTemplate, HevyWorkout } from "../integrations/hevy/types";
import type { CoachToolContext } from "./tools";
import type { CoachModelClient, CoachModelMessage, CoachModelStream } from "./coach";

/* ------------------------------------------------------------ memory store */

export class MemStore implements Store {
  constructor(
    public program: Program,
    public logs: SessionLog[] = [],
    public coachThreads: CoachThread[] = [],
  ) {}

  async getProgram(): Promise<Program> {
    return structuredClone(this.program);
  }
  async saveProgram(program: Program): Promise<void> {
    this.program = structuredClone(program);
  }
  async updateProgram(fn: (program: Program) => Program): Promise<Program> {
    // Same contract as FileStore: if fn throws, nothing is written.
    const next = fn(structuredClone(this.program));
    this.program = structuredClone(next);
    return next;
  }
  async getLogs(): Promise<SessionLog[]> {
    return structuredClone(this.logs);
  }
  async appendLog(log: SessionLog): Promise<SessionLog> {
    this.logs.push(structuredClone(log));
    return log;
  }
  async getCoachThreads(): Promise<CoachThread[]> {
    return structuredClone(this.coachThreads);
  }
  async startCoachThread(firstMessage: CoachMessage): Promise<CoachThread> {
    const thread: CoachThread = {
      id: crypto.randomUUID(),
      title: coachThreadTitle(firstMessage.content),
      messages: [structuredClone(firstMessage)],
      createdAt: firstMessage.createdAt,
      updatedAt: firstMessage.createdAt,
    };
    this.coachThreads.push(thread);
    return structuredClone(thread);
  }
  async appendCoachMessage(threadId: string, message: CoachMessage): Promise<CoachThread> {
    const thread = this.coachThreads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error("Coach conversation not found.");
    if (!thread.messages.some((existing) => existing.id === message.id)) {
      thread.messages.push(structuredClone(message));
      thread.updatedAt = message.createdAt;
    }
    return structuredClone(thread);
  }
}

/* -------------------------------------------------------------- program */

function flatWave(reps: number, sets: number, rir: number): WaveConfig {
  return {
    goal: "hypertrophy",
    shape: "flat",
    waveLength: 3,
    repsStart: reps,
    repsEnd: reps,
    setsStart: sets,
    setsEnd: sets,
    rirStart: rir,
    rirEnd: rir,
    intensityStart: 1,
    intensityEnd: 1,
  };
}

function ex(partial: Partial<Exercise> & Pick<Exercise, "id" | "name" | "muscle" | "loadBasis" | "rule" | "wave">): Exercise {
  return {
    compound: false,
    usesOpeningSingle: false,
    openingSingleRpe: 8,
    rounding: { increment: 5, mode: "nearest" },
    ...partial,
  };
}

/** Two full-body days, lb, 3 weeks + 1 deload (4 total). */
export function fixtureProgram(): Program {
  return {
    id: "test-program",
    name: "Test Block",
    locked: false,
    cycle: {
      weeksOn: 3,
      weeksOff: 1,
      mesocycles: 1,
      unit: "lb",
      rounding: { increment: 5, mode: "nearest" },
    },
    days: [
      {
        id: "day-a",
        name: "Full Body A",
        exercises: [
          ex({
            id: "squat-1", name: "Back Squat", muscle: "Quadriceps", compound: true,
            loadBasis: "max", e1rm: 300, rule: "calibration",
            wave: flatWave(5, 3, 2),
            warmup: { profile: "standard", startLoad: 45 },
          }),
          ex({
            id: "row-2", name: "Chest Supported Row", muscle: "Back",
            loadBasis: "work", workWeight: 100, rule: "double-progression",
            wave: flatWave(10, 3, 2), repCap: 15,
          }),
          ex({
            id: "curl-3", name: "Hammer Curl", muscle: "Biceps",
            loadBasis: "work", workWeight: 30, rule: "drop-set",
            wave: flatWave(10, 2, 0),
          }),
        ],
      },
      {
        id: "day-b",
        name: "Full Body B",
        exercises: [
          ex({
            id: "bench-4", name: "Bench Press", muscle: "Chest", compound: true,
            loadBasis: "max", e1rm: 225, rule: "calibration",
            wave: flatWave(5, 3, 2),
            warmup: { profile: "standard", startLoad: 45 },
          }),
          ex({
            id: "rdl-5", name: "Romanian Deadlift", muscle: "Hamstrings", compound: true,
            loadBasis: "work", workWeight: 185, rule: "linear",
            wave: flatWave(8, 3, 2),
          }),
          ex({
            id: "pushdown-6", name: "Triceps Pushdown", muscle: "Triceps",
            loadBasis: "work", workWeight: 40, rule: "double-progression",
            wave: flatWave(12, 2, 1), repCap: 20,
          }),
        ],
      },
    ],
  };
}

export function fixtureState(overrides: Partial<BlockState> = {}): BlockState {
  return {
    block: "main",
    currentWeek: 2,
    startDate: "2026-07-06",
    lastAdvancedISO: "2026-07-05T21:00:00.000Z",
    ...overrides,
  };
}

export function fixtureLogs(): SessionLog[] {
  return [
    {
      id: "squat-1-w2-2026-07-06",
      programId: "test-program",
      dayId: "day-a",
      exerciseId: "squat-1",
      exerciseName: "Back Squat",
      week: 2,
      date: "2026-07-06T18:00:00.000Z",
      sets: [
        { weight: 255, reps: 5, rpe: 8 },
        { weight: 255, reps: 5, rpe: 8.5 },
        { weight: 255, reps: 5, rpe: 9 },
      ],
      decisionNote: "Calibration: e1RM confirmed at 300lb.",
    },
    {
      id: "row-2-w1-2026-07-02",
      programId: "test-program",
      dayId: "day-a",
      exerciseId: "row-2",
      exerciseName: "Chest Supported Row",
      week: 1,
      date: "2026-07-02T18:00:00.000Z",
      sets: [{ weight: 100, reps: 12, rpe: 8 }],
      decisionNote: "Double progression: +1 rep next time.",
    },
  ];
}

/* ------------------------------------------------------------- fake Hevy */

const KG_PER_LB = 0.45359237;
export const lbToKg = (lb: number) => Math.round(lb * KG_PER_LB * 100) / 100;

export function fixtureTemplates(): HevyExerciseTemplate[] {
  const t = (id: string, title: string, muscle: string): HevyExerciseTemplate => ({
    id,
    title,
    type: "weight_reps",
    primary_muscle_group: muscle,
    secondary_muscle_groups: [],
    is_custom: false,
  });
  return [
    t("tmpl-squat", "Squat (Barbell)", "quadriceps"),
    t("tmpl-bench", "Bench Press (Barbell)", "chest"),
    t("tmpl-row", "Chest Supported Row (Dumbbell)", "upper_back"),
    t("tmpl-curl", "Hammer Curl (Dumbbell)", "biceps"),
    t("tmpl-rdl", "Romanian Deadlift (Barbell)", "hamstrings"),
    t("tmpl-pushdown", "Triceps Pushdown (Cable)", "triceps"),
  ];
}

export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

export interface FakeHevy {
  fetch: typeof fetch;
  calls: RecordedCall[];
  writes(): RecordedCall[];
}

export interface FakeHevyOptions {
  templates?: HevyExerciseTemplate[];
  workouts?: HevyWorkout[];
  routines?: Array<{ id: string; title: string; folder_id: number | null }>;
  measurements?: Array<{ date: string; weight_kg: number | null }>;
}

/** A tiny in-memory Hevy API: serves reads from fixtures, records all writes. */
export function fakeHevy(opts: FakeHevyOptions = {}): FakeHevy {
  const templates = opts.templates ?? fixtureTemplates();
  const workouts = opts.workouts ?? [];
  const routines = opts.routines ?? [];
  const measurements = opts.measurements ?? [];
  const calls: RecordedCall[] = [];
  let createdCounter = 0;

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    if (method === "GET") {
      if (path === "/v1/user/info") return json({ data: { id: "u1", name: "Athlete", url: "" } });
      if (path === "/v1/workouts/count") return json({ workout_count: workouts.length });
      if (path === "/v1/workouts") return json({ page: 1, page_count: 1, workouts });
      if (path === "/v1/exercise_templates") return json({ page: 1, page_count: 1, exercise_templates: templates });
      if (path === "/v1/routines") return json({ page: 1, page_count: 1, routines });
      if (path === "/v1/body_measurements") return json({ page: 1, page_count: 1, body_measurements: measurements });
    }
    if (method === "POST") {
      createdCounter++;
      if (path === "/v1/routines") return json({ routine: { id: `new-routine-${createdCounter}` } });
      if (path === "/v1/routine_folders") return json({ routine_folder: { id: 700 + createdCounter } });
      if (path === "/v1/exercise_templates") return json({ id: `custom-tmpl-${createdCounter}` });
    }
    if (method === "PUT" && path.startsWith("/v1/routines/")) {
      return json({ routine: { id: path.split("/").pop() } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    calls,
    writes: () => calls.filter((c) => c.method !== "GET"),
  };
}

/** A realistic recent Hevy workout: Full Body B done Thursday 2026-07-09. */
export function fixtureWorkouts(): HevyWorkout[] {
  const set = (weightLb: number | null, reps: number, type = "normal", rpe: number | null = null) => ({
    index: 0,
    type,
    weight_kg: weightLb == null ? null : lbToKg(weightLb),
    reps,
    distance_meters: null,
    duration_seconds: null,
    rpe,
    custom_metric: null,
  });
  return [
    {
      id: "w-thu",
      title: "W2 Full Body B (Thu 07-09) [day-b]",
      start_time: "2026-07-09T17:00:00Z",
      end_time: "2026-07-09T18:10:00Z",
      created_at: "2026-07-09T18:10:00Z",
      updated_at: "2026-07-09T18:10:00Z",
      exercises: [
        {
          index: 0,
          title: "Bench Press (Barbell)",
          exercise_template_id: "tmpl-bench",
          sets: [set(135, 5, "warmup"), set(200, 5, "normal", 8), set(200, 5, "normal", 8.5), set(200, 5, "normal", 9)],
        },
        {
          index: 1,
          title: "Romanian Deadlift (Barbell)",
          exercise_template_id: "tmpl-rdl",
          sets: [set(185, 8, "normal", 8), set(185, 8, "normal", 8.5)],
        },
      ],
    },
    {
      id: "w-old",
      title: "Old session",
      start_time: "2026-05-01T17:00:00Z",
      end_time: "2026-05-01T18:00:00Z",
      created_at: "2026-05-01T18:00:00Z",
      updated_at: "2026-05-01T18:00:00Z",
      exercises: [
        {
          index: 0,
          title: "Squat (Barbell)",
          exercise_template_id: "tmpl-squat",
          sets: [set(100, 5)],
        },
      ],
    },
  ];
}

/* ------------------------------------------------------------ tool context */

/** Saturday morning, between the Thu session and a hypothetical Sun/Mon pair. */
export const FIXED_NOW = new Date("2026-07-11T10:00:00.000Z");

export interface CtxOptions {
  store?: MemStore;
  state?: BlockState;
  hevy?: FakeHevy | null;
  now?: Date;
}

export function makeCtx(opts: CtxOptions = {}): { ctx: CoachToolContext; store: MemStore; hevy: FakeHevy | null } {
  const store = opts.store ?? new MemStore(fixtureProgram(), fixtureLogs());
  const hevy = opts.hevy === undefined ? fakeHevy() : opts.hevy;
  const ctx: CoachToolContext = {
    store,
    now: () => opts.now ?? FIXED_NOW,
    getBlockState: async () => opts.state ?? fixtureState(),
    hevyApiKey: hevy ? "test-key" : null,
    fetch: hevy?.fetch,
  };
  return { ctx, store, hevy };
}

/* ---------------------------------------------------------- scripted model */

export interface ScriptedResponse {
  text?: string;
  toolCalls?: Array<{ id?: string; name: string; input: unknown }>;
}

export interface ScriptedModel {
  client: CoachModelClient;
  /** Every params object passed to stream(), in order. */
  requests: Array<Record<string, unknown>>;
}

/**
 * A model that plays back a fixed script: response N answers request N.
 * Emits text as two text_delta events (exercising delta concatenation), then a
 * finalMessage with optional tool_use blocks (stop_reason "tool_use").
 */
export function scriptedModel(script: ScriptedResponse[]): ScriptedModel {
  const requests: Array<Record<string, unknown>> = [];
  let call = 0;

  const client: CoachModelClient = {
    stream(params) {
      // Snapshot: the loop mutates its live `messages` array after this call
      // (exactly what the real SDK serializes at request time).
      requests.push(structuredClone(params));
      const step = script[call] ?? { text: "(script exhausted)" };
      const index = call++;
      const content: Array<Record<string, unknown>> = [];
      if (step.text) content.push({ type: "text", text: step.text });
      const toolUses = (step.toolCalls ?? []).map((t, j) => ({
        type: "tool_use",
        id: t.id ?? `toolu_${index}_${j}`,
        name: t.name,
        input: t.input,
      }));
      content.push(...toolUses);

      const events: unknown[] = [];
      if (step.text) {
        const mid = Math.ceil(step.text.length / 2);
        events.push(
          { type: "content_block_delta", delta: { type: "text_delta", text: step.text.slice(0, mid) } },
          { type: "content_block_delta", delta: { type: "text_delta", text: step.text.slice(mid) } },
        );
      }

      const message: CoachModelMessage = {
        content,
        stop_reason: toolUses.length ? "tool_use" : "end_turn",
      };

      const stream: CoachModelStream = {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
        },
        finalMessage: async () => message,
      };
      return stream;
    },
  };

  return { client, requests };
}

/* ------------------------------------------------------------ event helpers */

export async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
