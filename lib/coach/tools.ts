/**
 * Coach tool harness — everything the conversational coach can *do*.
 *
 * Each tool is (a) an Anthropic tool definition (JSON Schema the model sees) and
 * (b) a zod-validated executor. Executors run against a CoachToolContext so the
 * whole harness is testable with an in-memory store, a fake clock, and a stubbed
 * Hevy fetch — no network, no filesystem.
 *
 * Design rules:
 *  - Read tools are cheap and side-effect free.
 *  - Write tools (update_program, set_program_lock, log_session) go through the
 *    store's atomic read-modify-write and respect the program lock.
 *  - push_to_hevy defaults to a DRY RUN (`push: false`); the model must show the
 *    plan before writing to the athlete's real Hevy account.
 *  - Every failure returns a friendly `{ error }` payload with `isError: true`
 *    so the model can recover instead of the loop crashing.
 */
import { z } from "zod";
import type {
  Exercise,
  MuscleGroup,
  Program,
  ProgressionRuleId,
  TrainingDay,
  WaveConfig,
} from "../engine/types";
import { applySession, buildCalendar, dayWeekView, planningCheck } from "../engine";
import { RULE_META } from "../engine/rules";
import { rpeFromRir } from "../engine/e1rm";
import type { SessionLog, Store } from "../store/types";
import { getStore } from "../store/fileStore";
import { readBlockState, type BlockState } from "../store/blockState";
import {
  actualWeekVolume,
  exportWeekToHevy,
  fromKg,
  HevyApiError,
  HevyClient,
  parseDayIdFromTitle,
  weekForWorkout,
  workoutImpact,
} from "../integrations/hevy";
import { buildProgressSnapshot } from "../progress";

/* ------------------------------------------------------------------ context */

export interface CoachToolContext {
  store: Store;
  /** Injectable clock (tests freeze it; prod uses the real one). */
  now(): Date;
  getBlockState(): Promise<BlockState>;
  hevyApiKey: string | null;
  hevyBaseUrl?: string;
  /** Injectable fetch for the Hevy client (tests pass a stub). */
  fetch?: typeof fetch;
}

export function defaultCoachContext(): CoachToolContext {
  return {
    store: getStore(),
    now: () => new Date(),
    getBlockState: readBlockState,
    hevyApiKey: (process.env.HEVY_API_KEY ?? "").trim() || null,
    hevyBaseUrl: process.env.HEVY_API_BASE,
  };
}

/** Friendly, expected failures — surfaced to the model as `{ error }`. */
class CoachToolError extends Error {}

function hevyClient(ctx: CoachToolContext): HevyClient {
  if (!ctx.hevyApiKey) {
    throw new CoachToolError(
      "The server-side Hevy connection is unavailable. Integration credentials are server-owned; continue with local plan data where possible.",
    );
  }
  return new HevyClient({
    apiKey: ctx.hevyApiKey,
    baseUrl: ctx.hevyBaseUrl,
    fetch: ctx.fetch,
  });
}

/* ------------------------------------------------------------- date helpers */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** The plan's default training weekdays (UTC day index): Mon / Thu / Sat. */
const DEFAULT_TRAINING_DOWS = new Set([1, 4, 6]);

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function weekdayOf(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}
/** "2026-07-12" → "Sun 07-12" (the routine-title label style). */
function shortDayLabel(iso: string): string {
  return `${weekdayOf(iso).slice(0, 3)} ${iso.slice(5)}`;
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function clampWeek(program: Program, week: number): number {
  const total = buildCalendar(program.cycle).length;
  return Math.min(Math.max(1, week), total);
}

/* ------------------------------------------------------- shared serializers */

function exerciseDetail(ex: Exercise) {
  return {
    id: ex.id,
    name: ex.name,
    muscle: ex.muscle,
    compound: ex.compound,
    loadBasis: ex.loadBasis,
    e1rm: ex.e1rm,
    workWeight: ex.workWeight,
    perHand: ex.perHand ?? false,
    rule: ex.rule,
    ruleName: RULE_META[ex.rule].name,
    repCap: ex.repCap,
    repTarget: ex.repTarget,
    rirCap: ex.rirCap,
    usesOpeningSingle: ex.usesOpeningSingle,
    warmup: ex.warmup?.profile ?? null,
    wave: { ...ex.wave },
  };
}

function volumeSummary(program: Program, week: number) {
  const check = planningCheck(program, week);
  return {
    week: check.week,
    totalSets: check.totalSets,
    totalReps: check.totalReps,
    byMuscle: check.byMuscle.map((m) => ({
      muscle: m.muscle,
      sets: m.sets,
      sharePct: Math.round(m.share * 100),
      verdict: m.verdict,
      landmarks: m.landmark,
    })),
    warnings: check.warnings,
  };
}

/** Concrete "what you'd actually do" lines for one day at one week. */
function daySnapshot(program: Program, day: TrainingDay, week: number) {
  const unit = program.cycle.unit;
  return {
    dayId: day.id,
    dayName: day.name,
    exercises: dayWeekView(program, day.id, week).map((v) => {
      const { exercise: e, prescription: p } = v;
      const bodyweight = e.loadBasis === "work" && (e.workWeight ?? 0) === 0 && p.load === 0;
      return {
        exerciseId: e.id,
        name: e.name,
        muscle: e.muscle,
        line: `${bodyweight ? "BW" : `${p.load}${unit}`} × ${p.reps}${e.repCap && e.repCap > p.reps ? `-${e.repCap}` : ""} × ${p.sets} sets @ ${p.rirCutoff} RIR${e.rule === "drop-set" ? " (dropset finisher)" : ""}`,
      };
    }),
  };
}

/* ============================================================ tool schemas */

const MUSCLE_VALUES = [
  "Quadriceps", "Hamstrings", "Glutes", "Chest", "Back", "Shoulders",
  "Biceps", "Triceps", "Calves", "Abs", "Forearms",
] as const satisfies readonly MuscleGroup[];

const RULE_VALUES = [
  "set-threshold-rir", "last-set-rir", "reps-to-failure", "double-progression",
  "linear", "amrap-top-set", "five-three-one", "top-set-backoff",
  "compound-hypertrophy", "drop-set", "calibration",
] as const satisfies readonly ProgressionRuleId[];

const WaveEditSchema = z
  .object({
    shape: z.enum(["descending-wave", "linear-ramp", "step", "flat"]),
    goal: z.enum(["strength", "hypertrophy", "peaking"]),
    waveLength: z.number().int().min(1).max(8),
    repsStart: z.number().int().min(1).max(30),
    repsEnd: z.number().int().min(1).max(30),
    setsStart: z.number().int().min(1).max(10),
    setsEnd: z.number().int().min(1).max(10),
    rirStart: z.number().min(0).max(6),
    rirEnd: z.number().min(0).max(6),
    intensityStart: z.number().min(0.3).max(1.5),
    intensityEnd: z.number().min(0.3).max(1.5),
  })
  .partial()
  .strict();

const ExerciseFieldEditSchema = z
  .object({
    name: z.string().min(1),
    muscle: z.enum(MUSCLE_VALUES),
    compound: z.boolean(),
    perHand: z.boolean(),
    e1rm: z.number().positive(),
    workWeight: z.number().min(0),
    /** Shorthand: sets every week to this value (flattens the wave dimension). */
    sets: z.number().int().min(1).max(10),
    reps: z.number().int().min(1).max(30),
    rir: z.number().min(0).max(6),
    repCap: z.number().int().min(1).max(40).nullable(),
    repTarget: z.number().int().min(1).max(30).nullable(),
    rirCap: z.number().min(0).max(6).nullable(),
    rule: z.enum(RULE_VALUES),
    usesOpeningSingle: z.boolean(),
    wave: WaveEditSchema,
  })
  .partial()
  .strict();

const NewExerciseSchema = z
  .object({
    name: z.string().min(1),
    muscle: z.enum(MUSCLE_VALUES),
    compound: z.boolean().default(false),
    loadBasis: z.enum(["max", "work"]),
    e1rm: z.number().positive().optional(),
    workWeight: z.number().min(0).optional(),
    sets: z.number().int().min(1).max(10),
    reps: z.number().int().min(1).max(30),
    rir: z.number().min(0).max(6).default(2),
    rule: z.enum(RULE_VALUES).optional(),
    repCap: z.number().int().min(1).max(40).optional(),
    repTarget: z.number().int().min(1).max(30).optional(),
    warmupProfile: z.enum(["standard", "deadlift", "none"]).default("none"),
    usesOpeningSingle: z.boolean().default(false),
    perHand: z.boolean().optional(),
  })
  .strict()
  .superRefine((ex, ctx2) => {
    if (ex.loadBasis === "max" && ex.e1rm == null)
      ctx2.addIssue({ code: z.ZodIssueCode.custom, message: "loadBasis 'max' requires e1rm" });
    if (ex.loadBasis === "work" && ex.workWeight == null)
      ctx2.addIssue({ code: z.ZodIssueCode.custom, message: "loadBasis 'work' requires workWeight (0 = bodyweight)" });
  });

const EditOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update_exercise"), exerciseId: z.string(), set: ExerciseFieldEditSchema }).strict(),
  z.object({ op: z.literal("add_exercise"), dayId: z.string(), position: z.number().int().min(0).optional(), exercise: NewExerciseSchema }).strict(),
  z.object({ op: z.literal("remove_exercise"), exerciseId: z.string() }).strict(),
  z.object({ op: z.literal("move_exercise"), exerciseId: z.string(), toDayId: z.string(), position: z.number().int().min(0).optional() }).strict(),
  z.object({ op: z.literal("rename_day"), dayId: z.string(), name: z.string().min(1) }).strict(),
  z.object({ op: z.literal("add_day"), name: z.string().min(1), position: z.number().int().min(0).optional() }).strict(),
  z.object({ op: z.literal("remove_day"), dayId: z.string() }).strict(),
  z.object({ op: z.literal("reorder_days"), dayIds: z.array(z.string()).min(1) }).strict(),
]);

const INPUT_SCHEMAS = {
  get_schedule: z.object({}).strict(),
  get_program: z.object({}).strict(),
  get_day_prescriptions: z
    .object({ dayId: z.string(), week: z.number().int().min(1).optional() })
    .strict(),
  get_week_volume: z.object({ week: z.number().int().min(1).optional() }).strict(),
  get_recent_logs: z
    .object({ limit: z.number().int().min(1).max(100).optional(), exercise: z.string().optional() })
    .strict(),
  get_progression_rules: z.object({}).strict(),
  get_hevy_workouts: z
    .object({
      days: z.number().int().min(1).max(365).default(14),
      maxWorkouts: z.number().int().min(1).max(50).default(15),
    })
    .strict(),
  list_hevy_routines: z.object({}).strict(),
  get_progress_snapshot: z
    .object({ windowDays: z.number().int().min(30).max(3650).default(180) })
    .strict(),
  update_program: z.object({ edits: z.array(EditOpSchema).min(1).max(30) }).strict(),
  set_program_lock: z.object({ locked: z.boolean() }).strict(),
  log_session: z
    .object({
      dayId: z.string(),
      exerciseId: z.string(),
      week: z.number().int().min(1).optional(),
      date: z.string().optional(),
      openingSingle: z.object({ weight: z.number().positive(), rpe: z.number().min(1).max(10) }).optional(),
      sets: z
        .array(z.object({ weight: z.number().min(0), reps: z.number().int().min(0), rpe: z.number().min(1).max(10) }))
        .min(1),
      setsCompleted: z.number().int().min(0).optional(),
    })
    .strict(),
  push_to_hevy: z
    .object({
      week: z.number().int().min(1).optional(),
      dayIds: z.array(z.string()).min(1).optional(),
      mode: z.enum(["update", "create"]).default("update"),
      push: z.boolean().default(false),
      datesByDayId: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")).optional(),
      titlePrefix: z.string().optional(),
      folderTitle: z.string().optional(),
      createCustom: z.boolean().default(true),
    })
    .strict(),
} as const;

export type CoachToolName = keyof typeof INPUT_SCHEMAS;

/* ===================================================== tool definitions
 * The JSON Schemas the model sees. Kept in sync with the zod schemas above
 * (zod is the runtime source of truth; violations come back as tool errors).
 * -------------------------------------------------------------------- */

interface ToolDefinition {
  name: CoachToolName;
  description: string;
  input_schema: Record<string, unknown>;
}

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;
const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

const WAVE_EDIT_PROPS = obj({
  shape: { type: "string", enum: ["descending-wave", "linear-ramp", "step", "flat"] },
  goal: { type: "string", enum: ["strength", "hypertrophy", "peaking"] },
  waveLength: int, repsStart: int, repsEnd: int, setsStart: int, setsEnd: int,
  rirStart: num, rirEnd: num, intensityStart: num, intensityEnd: num,
});

export const COACH_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_schedule",
    description:
      "Call this FIRST whenever the athlete mentions days or dates ('tomorrow', 'Sunday', 'back to back', 'this week'). Returns today's date and weekday (UTC), the training-block state (block name, current week, total weeks, deload flag), the program's day list, the default training weekdays (Mon/Thu/Sat — the athlete may deviate; trust their stated plan), the next 14 calendar days, and which program days were already logged this week.",
    input_schema: obj({}),
  },
  {
    name: "get_program",
    description:
      "Read the full training program: every day and exercise with its ids (needed for edits), muscle, load basis (e1RM vs working weight), current anchors, progression rule, rep caps, warm-up profile, and the full wave (periodization) config. Call before editing anything with update_program.",
    input_schema: obj({}),
  },
  {
    name: "get_day_prescriptions",
    description:
      "The engine's concrete prescription for ONE training day at a given week: exact load × reps × sets @ RIR per exercise, marked warm-up ramp, opening-single suggestion, and coaching notes. Use to answer 'what am I doing tomorrow?' or to review a day before/after editing it.",
    input_schema: obj({ dayId: str, week: { ...int, description: "1-based program week; defaults to the current week" } }, ["dayId"]),
  },
  {
    name: "get_week_volume",
    description:
      "Weekly working-set volume per muscle. Returns the PLAN (sets with MEV/MAV/MRV landmarks and an under/productive/high/over verdict, plus total sets/reps) and, when Hevy is configured, `actual`: the sets REALLY done that week — per-muscle done-vs-planned split into planned lifts / same-muscle swaps / unplanned extras, plus the list of swaps (e.g. dumbbell row → iso-row machine) and extras. Gym-floor substitutions and extra sets count toward the muscle; a swap never moves the planned lift's load anchor. Call after program edits to sanity-check volume, when asked about under-/over-dosed muscles, or for 'how has my week actually gone?'.",
    input_schema: obj({ week: int }),
  },
  {
    name: "get_recent_logs",
    description:
      "Recent in-app session logs (newest first): date, week, exercise, opening single, work sets with RPE, and the progression decision the engine made. Use for 'how did X go?' and to see what's already been trained this week.",
    input_schema: obj({ limit: { ...int, description: "default 20, max 100" }, exercise: { ...str, description: "filter by exercise name (case-insensitive substring)" } }),
  },
  {
    name: "get_progression_rules",
    description:
      "The progression rules used by this program (name, what they do, when they fire, watch-outs, evidence base) plus the full list of rule ids available for update_program/add_exercise.",
    input_schema: obj({}),
  },
  {
    name: "get_hevy_workouts",
    description:
      "The athlete's REAL recent workouts pulled live from Hevy (what actually happened in the gym, including sessions not logged in this app): date, title, matched program day, and every set with weight (converted to the program's unit), reps, RPE, and set type (warmup/normal/dropset). Use to ground advice in actual training and to see what was trained on which day.",
    input_schema: obj({ days: { ...int, description: "look-back window, default 14" }, maxWorkouts: { ...int, description: "default 15, max 50" } }),
  },
  {
    name: "list_hevy_routines",
    description:
      "List the routines currently on the athlete's Hevy account (id, title, folder, and which program day each maps to via the [day-id] title marker). Call before push_to_hevy in update mode to confirm which routines would be overwritten.",
    input_schema: obj({}),
  },
  {
    name: "get_progress_snapshot",
    description:
      "Long-range progress from Hevy: estimated-1RM trend for the big lifts (squat/bench/deadlift/press) with recent data points, and bodyweight trend. Use for 'how is my bench trending?' or anything about strength/bodyweight over time.",
    input_schema: obj({ windowDays: { ...int, description: "default 180" } }),
  },
  {
    name: "update_program",
    description:
      "Edit the training plan (the local source of truth — Hevy is only updated when you push_to_hevy afterwards). Applies a list of edits atomically: all succeed or nothing is written. Edits are PERSISTENT plan changes (they affect this and future weeks): the sets/reps/rir shorthands flatten that dimension of the exercise's wave to the given value; use the nested wave object to keep week-to-week waving. Fails if the program is locked (offer set_program_lock). Returns the updated day snapshots and the new weekly volume check — review it and flag anything under MEV / over MRV.",
    input_schema: obj(
      {
        edits: {
          type: "array",
          minItems: 1,
          description:
            "Operations, applied in order. Shapes: " +
            '{op:"update_exercise", exerciseId, set:{name?, muscle?, compound?, perHand?, e1rm?, workWeight?, sets?, reps?, rir?, repCap?, repTarget?, rirCap?, rule?, usesOpeningSingle?, wave?:{...}}} · ' +
            '{op:"add_exercise", dayId, position?, exercise:{name, muscle, loadBasis:"max"|"work", e1rm? (required for max), workWeight? (required for work; 0 = bodyweight), sets, reps, rir?, rule?, repCap?, repTarget?, warmupProfile?:"standard"|"deadlift"|"none", compound?, usesOpeningSingle?, perHand?}} · ' +
            '{op:"remove_exercise", exerciseId} · {op:"move_exercise", exerciseId, toDayId, position?} · ' +
            '{op:"rename_day", dayId, name} · {op:"add_day", name, position?} · {op:"remove_day", dayId} · ' +
            '{op:"reorder_days", dayIds:[all day ids in the new order]}',
          items: obj({
            op: { type: "string", enum: ["update_exercise", "add_exercise", "remove_exercise", "move_exercise", "rename_day", "add_day", "remove_day", "reorder_days"] },
            exerciseId: str,
            dayId: str,
            toDayId: str,
            position: int,
            name: str,
            dayIds: { type: "array", items: str },
            set: obj({
              name: str,
              muscle: { type: "string", enum: [...MUSCLE_VALUES] },
              compound: bool, perHand: bool, e1rm: num, workWeight: num,
              sets: int, reps: int, rir: num,
              repCap: { type: ["integer", "null"] }, repTarget: { type: ["integer", "null"] }, rirCap: { type: ["number", "null"] },
              rule: { type: "string", enum: [...RULE_VALUES] },
              usesOpeningSingle: bool,
              wave: WAVE_EDIT_PROPS,
            }),
            exercise: obj({
              name: str,
              muscle: { type: "string", enum: [...MUSCLE_VALUES] },
              compound: bool,
              loadBasis: { type: "string", enum: ["max", "work"] },
              e1rm: num, workWeight: num, sets: int, reps: int, rir: num,
              rule: { type: "string", enum: [...RULE_VALUES] },
              repCap: int, repTarget: int,
              warmupProfile: { type: "string", enum: ["standard", "deadlift", "none"] },
              usesOpeningSingle: bool, perHand: bool,
            }, ["name", "muscle", "loadBasis", "sets", "reps"]),
          }, ["op"]),
        },
      },
      ["edits"],
    ),
  },
  {
    name: "set_program_lock",
    description:
      "Lock or unlock the program configuration. A locked program cannot be edited (update_program fails). Unlock only when the athlete asked for changes; re-lock afterwards if it was locked before.",
    input_schema: obj({ locked: bool }, ["locked"]),
  },
  {
    name: "log_session",
    description:
      "Record what the athlete just did for one exercise (work sets with weight/reps/RPE, optional opening single) and run the progression engine on it. Returns the engine's decision (e.g. 'e1RM +5lb') and the next-session preview. Use when the athlete reports a completed session in chat.",
    input_schema: obj(
      {
        dayId: str,
        exerciseId: str,
        week: { ...int, description: "defaults to the current block week" },
        date: { ...str, description: "ISO date; defaults to today" },
        openingSingle: obj({ weight: num, rpe: num }, ["weight", "rpe"]),
        sets: { type: "array", minItems: 1, items: obj({ weight: num, reps: int, rpe: num }, ["weight", "reps", "rpe"]) },
        setsCompleted: int,
      },
      ["dayId", "exerciseId", "sets"],
    ),
  },
  {
    name: "push_to_hevy",
    description:
      "Materialize program days as routines on the athlete's Hevy account. ALWAYS call with push:false first — that is a dry run returning exactly what would be written (routine titles, every set line, template matching) with NO writes. Only call with push:true after the plan is final and the athlete has approved (their original message may already grant approval, e.g. 'then push to Hevy'). mode 'update' overwrites the existing routines matched by the [day-id] title marker (normal weekly flow); 'create' makes a new folder + new routines. Use dayIds to push only specific days (e.g. just the two days being restructured) and datesByDayId to stamp each routine title with its planned date.",
    input_schema: obj({
      week: { ...int, description: "program week to materialize; defaults to the current block week" },
      dayIds: { type: "array", items: str, description: "subset of day ids to push; default all days" },
      mode: { type: "string", enum: ["update", "create"], description: "default update" },
      push: { ...bool, description: "false (default) = dry run, true = write to Hevy" },
      datesByDayId: { type: "object", description: 'dayId → "YYYY-MM-DD" planned date, stamped into the routine title (e.g. "Sun 07-12")', additionalProperties: str },
      titlePrefix: { ...str, description: 'routine title prefix; defaults to "W<week>"' },
      folderTitle: { ...str, description: "folder title (create mode only)" },
      createCustom: { ...bool, description: "create custom Hevy exercises for unmatched lifts (default true)" },
    }),
  },
];

/** Tools that mutate local app state (the route revalidates pages after these). */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "update_program",
  "set_program_lock",
  "log_session",
]);

/* ================================================================ executors */

export interface CoachToolOutcome {
  result: unknown;
  isError: boolean;
}

type ToolInput<N extends CoachToolName> = z.infer<(typeof INPUT_SCHEMAS)[N]>;

async function execGetSchedule(ctx: CoachToolContext): Promise<unknown> {
  const [program, logs, state] = await Promise.all([
    ctx.store.getProgram(),
    ctx.store.getLogs(),
    ctx.getBlockState(),
  ]);
  const calendar = buildCalendar(program.cycle);
  const week = clampWeek(program, state.currentWeek);
  const wk = calendar.find((w) => w.week === week) ?? calendar[0];
  const now = ctx.now();
  const today = isoDate(now);

  const next14 = Array.from({ length: 14 }, (_, i) => {
    const date = isoDate(addDays(now, i + 1));
    return { date, weekday: weekdayOf(date), isDefaultTrainingDay: DEFAULT_TRAINING_DOWS.has(new Date(`${date}T00:00:00Z`).getUTCDay()) };
  });

  const dayNames = new Map(program.days.map((d) => [d.id, d.name]));
  const loggedThisWeek = [
    ...new Map(
      logs
        .filter((l) => l.week === week)
        .map((l) => [`${l.date.slice(0, 10)}|${l.dayId}`, l] as const),
    ).values(),
  ].map((l) => ({ date: l.date.slice(0, 10), dayId: l.dayId, dayName: dayNames.get(l.dayId) ?? l.dayId }));

  return {
    today: { date: today, weekday: weekdayOf(today), timezone: "UTC" },
    block: {
      block: state.block,
      currentWeek: week,
      totalWeeks: calendar.length,
      weekLabel: wk.label,
      isDeload: wk.isDeload,
      startDate: state.startDate,
      lastAdvanced: state.lastAdvancedISO,
    },
    program: {
      id: program.id,
      name: program.name,
      unit: program.cycle.unit,
      locked: program.locked,
      days: program.days.map((d) => ({ id: d.id, name: d.name, exercises: d.exercises.length })),
    },
    defaultTrainingWeekdays: ["Monday", "Thursday", "Saturday"],
    next14Days: next14,
    loggedThisWeek,
    note:
      "Dates are UTC. Mon/Thu/Sat is the default pattern only — if the athlete says they are training other days (e.g. Sunday + Monday back to back), plan around THEIR days. Program days are performed in order; the weekday is just a label.",
  };
}

async function execGetProgram(ctx: CoachToolContext): Promise<unknown> {
  const program = await ctx.store.getProgram();
  return {
    id: program.id,
    name: program.name,
    locked: program.locked,
    unit: program.cycle.unit,
    cycle: {
      weeksOn: program.cycle.weeksOn,
      weeksOff: program.cycle.weeksOff,
      mesocycles: program.cycle.mesocycles,
      totalWeeks: buildCalendar(program.cycle).length,
      rounding: program.cycle.rounding,
    },
    days: program.days.map((d) => ({ id: d.id, name: d.name, exercises: d.exercises.map(exerciseDetail) })),
  };
}

async function execGetDayPrescriptions(input: ToolInput<"get_day_prescriptions">, ctx: CoachToolContext): Promise<unknown> {
  const [program, state] = await Promise.all([ctx.store.getProgram(), ctx.getBlockState()]);
  const day = program.days.find((d) => d.id === input.dayId);
  if (!day) {
    throw new CoachToolError(
      `Unknown dayId "${input.dayId}". Valid day ids: ${program.days.map((d) => d.id).join(", ")}.`,
    );
  }
  const week = clampWeek(program, input.week ?? state.currentWeek);
  const calendar = buildCalendar(program.cycle);
  const unit = program.cycle.unit;
  const views = dayWeekView(program, day.id, week);
  return {
    dayId: day.id,
    dayName: day.name,
    week,
    weekLabel: calendar.find((w) => w.week === week)?.label,
    isDeload: calendar.find((w) => w.week === week)?.isDeload ?? false,
    unit,
    exercises: views.map((v) => {
      const { exercise: e, prescription: p } = v;
      const bodyweight = e.loadBasis === "work" && (e.workWeight ?? 0) === 0 && p.load === 0;
      return {
        exerciseId: e.id,
        name: e.name,
        muscle: e.muscle,
        rule: e.rule,
        load: bodyweight ? "bodyweight" : p.load,
        reps: p.reps,
        repRangeTop: e.repCap && e.repCap > p.reps ? e.repCap : undefined,
        sets: p.sets,
        rirCutoff: p.rirCutoff,
        targetRpe: rpeFromRir(p.rirCutoff),
        basisE1rm: p.basisE1rm,
        openingSingle: p.openingSingle,
        warmupSets: p.warmupSets,
        isDropsetFinisher: e.rule === "drop-set",
        notes: p.notes,
      };
    }),
  };
}

async function execGetWeekVolume(input: ToolInput<"get_week_volume">, ctx: CoachToolContext): Promise<unknown> {
  const [program, state] = await Promise.all([ctx.store.getProgram(), ctx.getBlockState()]);
  const week = clampWeek(program, input.week ?? state.currentWeek);
  return { ...volumeSummary(program, week), actual: await actualVolumeSummary(program, state, week, ctx) };
}

const DAY_MS = 86_400_000;

/**
 * The ACTUAL sets done in `week`, from Hevy: matched planned lifts, same-muscle
 * swaps, and unplanned extras all count (warm-ups never do). Degrades to
 * `{ unavailable }` instead of throwing so the planned check always comes back
 * even without a Hevy key or when Hevy is down.
 */
async function actualVolumeSummary(program: Program, state: BlockState, week: number, ctx: CoachToolContext): Promise<unknown> {
  let client: HevyClient;
  try {
    client = hevyClient(ctx);
  } catch (err) {
    return { unavailable: err instanceof Error ? err.message : String(err) };
  }
  try {
    const totalWeeks = buildCalendar(program.cycle).length;
    const startMs = Date.parse(`${state.startDate}T00:00:00Z`);
    const weekStartMs = Number.isNaN(startMs)
      ? ctx.now().getTime() - 14 * DAY_MS
      : startMs + (week - 1) * 7 * DAY_MS;
    // A full week of pad: the block's week counter can run ahead of pure date
    // math (ramp/early advance), and a routine's W-marker overrides its date —
    // fetch wide, then attribute precisely per workout via weekForWorkout.
    const since = new Date(weekStartMs - 7 * DAY_MS).toISOString();
    const [templates, workouts] = await Promise.all([
      client.getAllTemplates(),
      client.getAllWorkouts({ since, maxPages: 30 }),
    ]);
    const impacts = workouts.flatMap((workout) => {
      const workoutWeek = weekForWorkout(workout, state.startDate, totalWeeks);
      return workoutWeek == null ? [] : [workoutImpact(program, workout, templates, workoutWeek)];
    });
    const inWeek = impacts.filter((i) => i.week === week);
    const vol = actualWeekVolume(program, impacts, week);
    const working = (sets: Array<{ type: string }>) => sets.filter((s) => s.type !== "warmup").length;
    return {
      workoutsCounted: inWeek.length,
      totalSetsDone: vol.totalSets,
      byMuscle: vol.byMuscle.map((m) => ({
        muscle: m.muscle,
        setsDone: m.sets,
        plannedSets: m.plannedSets,
        fromPlanned: m.fromPlanned,
        fromSwaps: m.fromSwaps,
        fromExtras: m.fromExtras,
        verdict: m.verdict,
      })),
      unmappedSets: vol.unmappedSets,
      swaps: inWeek.flatMap((i) =>
        i.exercises
          .filter((r) => r.status === "swapped")
          .map((r) => ({
            date: i.startTime.slice(0, 10),
            planned: r.exercise.name,
            did: r.templateTitle,
            workingSets: working(r.actualSets),
          })),
      ),
      extras: inWeek.flatMap((i) =>
        i.extras.map((e) => ({
          date: i.startTime.slice(0, 10),
          title: e.title,
          muscle: e.muscle,
          workingSets: working(e.actualSets),
        })),
      ),
      note: "Actuals from Hevy. A swapped lift credits its muscle's volume but never moves the planned lift's load anchor; extras count toward volume only.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { unavailable: `Planned volume above is complete; actuals could not be fetched from Hevy — ${msg}` };
  }
}

async function execGetRecentLogs(input: ToolInput<"get_recent_logs">, ctx: CoachToolContext): Promise<unknown> {
  const logs = await ctx.store.getLogs();
  const filter = input.exercise?.toLowerCase();
  const rows = [...logs]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((l) => !filter || l.exerciseName.toLowerCase().includes(filter))
    .slice(0, input.limit ?? 20)
    .map((l) => ({
      date: l.date.slice(0, 10),
      week: l.week,
      dayId: l.dayId,
      exercise: l.exerciseName,
      openingSingle: l.openingSingle,
      sets: l.sets,
      setsCompleted: l.setsCompleted,
      decision: l.decisionNote,
    }));
  return { count: rows.length, logs: rows };
}

async function execGetProgressionRules(ctx: CoachToolContext): Promise<unknown> {
  const program = await ctx.store.getProgram();
  const inUse = [...new Set(program.days.flatMap((d) => d.exercises.map((e) => e.rule)))];
  return {
    rulesInUse: inUse.map((id) => {
      const m = RULE_META[id];
      return { id, name: m.name, summary: m.summary, how: m.how, bestFor: m.bestFor, watchOut: m.watchOut, evidence: m.evidence };
    }),
    allRules: (Object.keys(RULE_META) as ProgressionRuleId[]).map((id) => ({ id, name: RULE_META[id].name })),
  };
}

async function execGetHevyWorkouts(input: ToolInput<"get_hevy_workouts">, ctx: CoachToolContext): Promise<unknown> {
  const client = hevyClient(ctx);
  const program = await ctx.store.getProgram();
  const unit = program.cycle.unit;
  const since = new Date(ctx.now().getTime() - input.days * 86_400_000).toISOString();
  const workouts = await client.getAllWorkouts({ since, maxPages: 30 });
  const rows = [...workouts]
    .sort((a, b) => b.start_time.localeCompare(a.start_time))
    .slice(0, input.maxWorkouts)
    .map((w) => ({
      date: w.start_time.slice(0, 10),
      weekday: weekdayOf(w.start_time.slice(0, 10)),
      title: w.title,
      matchedDayId: parseDayIdFromTitle(w.title, program),
      exercises: w.exercises.map((e) => ({
        name: e.title,
        sets: e.sets
          .filter((s) => s.reps != null || s.weight_kg != null)
          .map((s) => ({
            type: s.type,
            weight: s.weight_kg == null ? null : Math.round(fromKg(s.weight_kg, unit) * 10) / 10,
            reps: s.reps,
            rpe: s.rpe,
          })),
      })),
    }));
  return { unit, windowDays: input.days, workouts: rows };
}

async function execListHevyRoutines(ctx: CoachToolContext): Promise<unknown> {
  const client = hevyClient(ctx);
  const program = await ctx.store.getProgram();
  const routines = await client.getAllRoutines();
  return {
    routines: routines.map((r) => ({
      id: r.id,
      title: r.title,
      folderId: r.folder_id,
      matchedDayId: parseDayIdFromTitle(r.title, program),
    })),
  };
}

async function execGetProgressSnapshot(input: ToolInput<"get_progress_snapshot">, ctx: CoachToolContext): Promise<unknown> {
  const client = hevyClient(ctx);
  const now = ctx.now().toISOString();
  const since = new Date(ctx.now().getTime() - input.windowDays * 86_400_000).toISOString();
  const [workouts, measurements] = await Promise.all([
    client.getAllWorkouts({ since, maxPages: 100 }),
    client.getAllBodyMeasurements(),
  ]);
  const snap = buildProgressSnapshot({ workouts, measurements, windowDays: input.windowDays, now });
  return {
    windowDays: snap.windowDays,
    workoutsScanned: snap.workoutsScanned,
    lifts: snap.lifts.map((l) => ({
      lift: l.label,
      latestE1rmLb: l.latest,
      bestE1rmLb: l.best,
      changeLb: l.changeLb,
      changePercent: l.changePercent,
      recentPoints: l.points.slice(-6).map((p) => ({ date: p.date.slice(0, 10), weightLb: p.weightLb, reps: p.reps, e1rmLb: p.estimated1RmLb })),
    })),
    bodyWeight: {
      latestLb: snap.bodyWeight.latest,
      changeLb: snap.bodyWeight.changeLb,
      lowLb: snap.bodyWeight.low,
      highLb: snap.bodyWeight.high,
      recentPoints: snap.bodyWeight.points.slice(-10),
    },
  };
}

/* ------------------------------------------------------------ program edits */

type EditOp = z.infer<typeof EditOpSchema>;

function findExercise(program: Program, exerciseId: string): { day: TrainingDay; index: number; exercise: Exercise } {
  for (const day of program.days) {
    const index = day.exercises.findIndex((e) => e.id === exerciseId);
    if (index !== -1) return { day, index, exercise: day.exercises[index] };
  }
  const ids = program.days.flatMap((d) => d.exercises.map((e) => e.id));
  throw new CoachToolError(`Unknown exerciseId "${exerciseId}". Valid ids: ${ids.join(", ")}.`);
}

function requireDay(program: Program, dayId: string): TrainingDay {
  const day = program.days.find((d) => d.id === dayId);
  if (!day) throw new CoachToolError(`Unknown dayId "${dayId}". Valid day ids: ${program.days.map((d) => d.id).join(", ")}.`);
  return day;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "exercise";
}

function uniqueId(program: Program, base: string): string {
  const existing = new Set([
    ...program.days.map((d) => d.id),
    ...program.days.flatMap((d) => d.exercises.map((e) => e.id)),
  ]);
  for (let n = 1; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function buildNewExercise(program: Program, spec: z.infer<typeof NewExerciseSchema>): Exercise {
  const rule: ProgressionRuleId = spec.rule ?? (spec.loadBasis === "max" ? "set-threshold-rir" : "double-progression");
  const wave: WaveConfig = {
    goal: "hypertrophy",
    shape: "flat",
    waveLength: 3,
    repsStart: spec.reps,
    repsEnd: spec.reps,
    setsStart: spec.sets,
    setsEnd: spec.sets,
    rirStart: spec.rir,
    rirEnd: spec.rir,
    intensityStart: 1,
    intensityEnd: 1,
  };
  const repCap = spec.repCap ?? (rule === "double-progression" ? spec.reps + 3 : undefined);
  return {
    id: uniqueId(program, slugify(spec.name)),
    name: spec.name,
    muscle: spec.muscle,
    compound: spec.compound,
    usesOpeningSingle: spec.usesOpeningSingle,
    openingSingleRpe: 8,
    ...(spec.warmupProfile !== "none"
      ? { warmup: { profile: spec.warmupProfile, startLoad: spec.warmupProfile === "deadlift" ? 95 : 45 } }
      : {}),
    loadBasis: spec.loadBasis,
    ...(spec.loadBasis === "max" ? { e1rm: spec.e1rm } : { workWeight: spec.workWeight }),
    ...(spec.perHand != null ? { perHand: spec.perHand } : {}),
    rule,
    wave,
    rounding: { ...program.cycle.rounding },
    ...(repCap != null ? { repCap } : {}),
    ...(spec.repTarget != null ? { repTarget: spec.repTarget } : {}),
  };
}

function applyEditOp(program: Program, op: EditOp, changes: string[], touchedDayIds: Set<string>): void {
  switch (op.op) {
    case "update_exercise": {
      const { day, exercise } = findExercise(program, op.exerciseId);
      touchedDayIds.add(day.id);
      const s = op.set;
      const delta: string[] = [];
      if (s.e1rm != null) {
        if (exercise.loadBasis !== "max")
          throw new CoachToolError(`${exercise.name} uses loadBasis "work" — set workWeight, not e1rm.`);
        delta.push(`e1rm ${exercise.e1rm ?? "?"}→${s.e1rm}`);
        exercise.e1rm = s.e1rm;
      }
      if (s.workWeight != null) {
        if (exercise.loadBasis !== "work")
          throw new CoachToolError(`${exercise.name} uses loadBasis "max" — set e1rm, not workWeight.`);
        delta.push(`workWeight ${exercise.workWeight ?? "?"}→${s.workWeight}`);
        exercise.workWeight = s.workWeight;
      }
      if (s.name != null) { delta.push(`name→"${s.name}"`); exercise.name = s.name; }
      if (s.muscle != null) { delta.push(`muscle ${exercise.muscle}→${s.muscle}`); exercise.muscle = s.muscle; }
      if (s.compound != null) { delta.push(`compound→${s.compound}`); exercise.compound = s.compound; }
      if (s.perHand != null) { delta.push(`perHand→${s.perHand}`); exercise.perHand = s.perHand; }
      if (s.rule != null) { delta.push(`rule ${exercise.rule}→${s.rule}`); exercise.rule = s.rule; }
      if (s.usesOpeningSingle != null) { delta.push(`openingSingle→${s.usesOpeningSingle}`); exercise.usesOpeningSingle = s.usesOpeningSingle; }
      if (s.repCap !== undefined) { delta.push(`repCap→${s.repCap ?? "none"}`); exercise.repCap = s.repCap ?? undefined; }
      if (s.repTarget !== undefined) { delta.push(`repTarget→${s.repTarget ?? "none"}`); exercise.repTarget = s.repTarget ?? undefined; }
      if (s.rirCap !== undefined) { delta.push(`rirCap→${s.rirCap ?? "none"}`); exercise.rirCap = s.rirCap ?? undefined; }
      if (s.sets != null) { delta.push(`sets ${exercise.wave.setsStart}-${exercise.wave.setsEnd}→${s.sets}`); exercise.wave.setsStart = s.sets; exercise.wave.setsEnd = s.sets; }
      if (s.reps != null) { delta.push(`reps ${exercise.wave.repsStart}-${exercise.wave.repsEnd}→${s.reps}`); exercise.wave.repsStart = s.reps; exercise.wave.repsEnd = s.reps; }
      if (s.rir != null) { delta.push(`rir ${exercise.wave.rirStart}-${exercise.wave.rirEnd}→${s.rir}`); exercise.wave.rirStart = s.rir; exercise.wave.rirEnd = s.rir; }
      if (s.wave != null) {
        Object.assign(exercise.wave, s.wave);
        delta.push(`wave{${Object.keys(s.wave).join(",")}}`);
      }
      if (!delta.length) throw new CoachToolError(`update_exercise for ${exercise.name}: "set" contained no changes.`);
      changes.push(`${exercise.name} (${day.name}): ${delta.join(", ")}`);
      break;
    }
    case "add_exercise": {
      const day = requireDay(program, op.dayId);
      touchedDayIds.add(day.id);
      const ex = buildNewExercise(program, op.exercise);
      const pos = Math.min(op.position ?? day.exercises.length, day.exercises.length);
      day.exercises.splice(pos, 0, ex);
      changes.push(`Added ${ex.name} [${ex.id}] to ${day.name} at position ${pos}`);
      break;
    }
    case "remove_exercise": {
      const { day, index, exercise } = findExercise(program, op.exerciseId);
      touchedDayIds.add(day.id);
      day.exercises.splice(index, 1);
      changes.push(`Removed ${exercise.name} from ${day.name}`);
      break;
    }
    case "move_exercise": {
      const { day, index, exercise } = findExercise(program, op.exerciseId);
      const target = requireDay(program, op.toDayId);
      touchedDayIds.add(day.id);
      touchedDayIds.add(target.id);
      day.exercises.splice(index, 1);
      const pos = Math.min(op.position ?? target.exercises.length, target.exercises.length);
      target.exercises.splice(pos, 0, exercise);
      changes.push(`Moved ${exercise.name}: ${day.name} → ${target.name} (position ${pos})`);
      break;
    }
    case "rename_day": {
      const day = requireDay(program, op.dayId);
      touchedDayIds.add(day.id);
      changes.push(`Renamed day "${day.name}" → "${op.name}"`);
      day.name = op.name;
      break;
    }
    case "add_day": {
      const id = uniqueId(program, slugify(op.name));
      const pos = Math.min(op.position ?? program.days.length, program.days.length);
      program.days.splice(pos, 0, { id, name: op.name, exercises: [] });
      touchedDayIds.add(id);
      changes.push(`Added day "${op.name}" [${id}] at position ${pos}`);
      break;
    }
    case "remove_day": {
      const day = requireDay(program, op.dayId);
      program.days = program.days.filter((d) => d.id !== op.dayId);
      changes.push(`Removed day "${day.name}" (${day.exercises.length} exercises dropped with it)`);
      break;
    }
    case "reorder_days": {
      const current = program.days.map((d) => d.id).sort();
      const proposed = [...op.dayIds].sort();
      if (current.length !== proposed.length || current.some((id, i) => id !== proposed[i])) {
        throw new CoachToolError(
          `reorder_days must list every existing day id exactly once. Existing: ${program.days.map((d) => d.id).join(", ")}.`,
        );
      }
      const byId = new Map(program.days.map((d) => [d.id, d]));
      program.days = op.dayIds.map((id) => byId.get(id)!);
      changes.push(`Reordered days: ${op.dayIds.join(" → ")}`);
      break;
    }
  }
}

async function execUpdateProgram(input: ToolInput<"update_program">, ctx: CoachToolContext): Promise<unknown> {
  const state = await ctx.getBlockState();
  let changes: string[] = [];
  let touched = new Set<string>();

  const next = await ctx.store.updateProgram((current) => {
    if (current.locked) {
      throw new CoachToolError(
        "The program is locked, so nothing was changed. If the athlete wants these edits, unlock with set_program_lock first (and offer to re-lock afterwards).",
      );
    }
    changes = [];
    touched = new Set<string>();
    const draft = structuredClone(current);
    for (const op of input.edits) applyEditOp(draft, op, changes, touched);
    if (draft.days.length === 0) throw new CoachToolError("Edits would leave the program with zero training days — rejected.");
    return draft;
  });

  const week = clampWeek(next, state.currentWeek);
  const emptyDays = next.days.filter((d) => d.exercises.length === 0).map((d) => d.name);
  return {
    applied: changes,
    days: [...touched]
      .filter((id) => next.days.some((d) => d.id === id))
      .map((id) => daySnapshot(next, next.days.find((d) => d.id === id)!, week)),
    volume: volumeSummary(next, week),
    ...(emptyDays.length ? { warnings: [`Days with no exercises: ${emptyDays.join(", ")}`] } : {}),
    reminder: "These edits are saved locally only. Hevy routines are unchanged until you push_to_hevy.",
  };
}

async function execSetProgramLock(input: ToolInput<"set_program_lock">, ctx: CoachToolContext): Promise<unknown> {
  await ctx.store.updateProgram((p) => ({ ...p, locked: input.locked }));
  return { locked: input.locked };
}

async function execLogSession(input: ToolInput<"log_session">, ctx: CoachToolContext): Promise<unknown> {
  const [program, state] = await Promise.all([ctx.store.getProgram(), ctx.getBlockState()]);
  const day = requireDay(program, input.dayId);
  const exercise = day.exercises.find((e) => e.id === input.exerciseId);
  if (!exercise) {
    throw new CoachToolError(
      `Exercise "${input.exerciseId}" is not on day "${day.name}". Its exercises: ${day.exercises.map((e) => e.id).join(", ")}.`,
    );
  }
  const week = clampWeek(program, input.week ?? state.currentWeek);
  const date = input.date ?? ctx.now().toISOString();

  const { decision, nextPreview } = applySession(program, exercise, week, {
    exerciseId: exercise.id,
    week,
    openingSingle: input.openingSingle,
    sets: input.sets,
    setsCompleted: input.setsCompleted,
  });

  const log: SessionLog = {
    id: `${input.exerciseId}-w${week}-${date}`,
    programId: program.id,
    dayId: input.dayId,
    exerciseId: input.exerciseId,
    exerciseName: exercise.name,
    week,
    date,
    openingSingle: input.openingSingle,
    sets: input.sets,
    setsCompleted: input.setsCompleted,
    decisionNote: decision.note,
  };
  await ctx.store.appendLog(log);

  return {
    logged: { exercise: exercise.name, week, date: date.slice(0, 10), sets: input.sets.length },
    decision: decision.note,
    nextSessionPreview: {
      load: nextPreview.load,
      reps: nextPreview.reps,
      sets: nextPreview.sets,
      rirCutoff: nextPreview.rirCutoff,
      unit: program.cycle.unit,
    },
  };
}

async function execPushToHevy(input: ToolInput<"push_to_hevy">, ctx: CoachToolContext): Promise<unknown> {
  const client = hevyClient(ctx);
  const [program, state] = await Promise.all([ctx.store.getProgram(), ctx.getBlockState()]);
  const week = clampWeek(program, input.week ?? state.currentWeek);

  if (input.dayIds) for (const id of input.dayIds) requireDay(program, id);
  const dayLabels: Record<string, string> = {};
  if (input.datesByDayId) {
    for (const [dayId, date] of Object.entries(input.datesByDayId)) {
      requireDay(program, dayId);
      dayLabels[dayId] = shortDayLabel(date);
    }
  }

  const result = await exportWeekToHevy(client, program, {
    week,
    dayIds: input.dayIds,
    mode: input.mode,
    dryRun: !input.push,
    createCustom: input.createCustom,
    titlePrefix: input.titlePrefix ?? `W${week}`,
    folderTitle: input.folderTitle,
    dayLabels,
  });

  const pushedDayIds = input.dayIds ?? program.days.map((d) => d.id);
  return {
    pushed: input.push,
    dryRun: !input.push,
    mode: result.mode,
    week: result.week,
    days: pushedDayIds,
    routines: result.routines.map((r) => ({
      title: r.title,
      exercises: r.exercises.map((e) => e._label),
    })),
    templateMatching: {
      matched: result.resolved.filter((r) => r.source === "matched").length,
      custom: result.resolved.filter((r) => r.source === "custom").length,
      customsCreated: result.customsCreated,
      unresolved: result.unresolved,
    },
    ...(input.push
      ? { written: { updated: result.updated, created: result.created, folderId: result.folderId } }
      : { note: "DRY RUN — nothing was written to Hevy. Review the routines above; call again with push:true to write them." }),
  };
}

/* ------------------------------------------------------------- dispatcher */

export async function runCoachTool(
  name: string,
  rawInput: unknown,
  ctx: CoachToolContext,
): Promise<CoachToolOutcome> {
  try {
    const schema = INPUT_SCHEMAS[name as CoachToolName];
    if (!schema) return { result: { error: `Unknown tool "${name}".` }, isError: true };
    const parsed = schema.parse(rawInput ?? {});

    switch (name as CoachToolName) {
      case "get_schedule": return { result: await execGetSchedule(ctx), isError: false };
      case "get_program": return { result: await execGetProgram(ctx), isError: false };
      case "get_day_prescriptions": return { result: await execGetDayPrescriptions(parsed as ToolInput<"get_day_prescriptions">, ctx), isError: false };
      case "get_week_volume": return { result: await execGetWeekVolume(parsed as ToolInput<"get_week_volume">, ctx), isError: false };
      case "get_recent_logs": return { result: await execGetRecentLogs(parsed as ToolInput<"get_recent_logs">, ctx), isError: false };
      case "get_progression_rules": return { result: await execGetProgressionRules(ctx), isError: false };
      case "get_hevy_workouts": return { result: await execGetHevyWorkouts(parsed as ToolInput<"get_hevy_workouts">, ctx), isError: false };
      case "list_hevy_routines": return { result: await execListHevyRoutines(ctx), isError: false };
      case "get_progress_snapshot": return { result: await execGetProgressSnapshot(parsed as ToolInput<"get_progress_snapshot">, ctx), isError: false };
      case "update_program": return { result: await execUpdateProgram(parsed as ToolInput<"update_program">, ctx), isError: false };
      case "set_program_lock": return { result: await execSetProgramLock(parsed as ToolInput<"set_program_lock">, ctx), isError: false };
      case "log_session": return { result: await execLogSession(parsed as ToolInput<"log_session">, ctx), isError: false };
      case "push_to_hevy": return { result: await execPushToHevy(parsed as ToolInput<"push_to_hevy">, ctx), isError: false };
    }
    return { result: { error: `Unhandled tool "${name}".` }, isError: true };
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");
      return { result: { error: `Invalid input for ${name}: ${issues}` }, isError: true };
    }
    if (err instanceof CoachToolError || err instanceof HevyApiError) {
      return { result: { error: err.message }, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { error: `${name} failed unexpectedly: ${msg}` }, isError: true };
  }
}

/* ----------------------------------------------------------- UI summaries */

/** Short human label for a tool call, shown as an activity chip in the chat. */
export function describeToolCall(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name as CoachToolName) {
    case "get_schedule": return "Checking today's date and schedule";
    case "get_program": return "Reading the program";
    case "get_day_prescriptions": return `Reading prescriptions for ${i.dayId ?? "a day"}${i.week ? ` (week ${i.week})` : ""}`;
    case "get_week_volume": return `Checking weekly volume${i.week ? ` (week ${i.week})` : ""}`;
    case "get_recent_logs": return "Reading recent session logs";
    case "get_progression_rules": return "Reading progression rules";
    case "get_hevy_workouts": return `Pulling recent Hevy workouts (${i.days ?? 14}d)`;
    case "list_hevy_routines": return "Listing Hevy routines";
    case "get_progress_snapshot": return "Pulling progress trends from Hevy";
    case "update_program": {
      const edits = Array.isArray(i.edits) ? i.edits.length : 0;
      return `Editing the program (${edits} change${edits === 1 ? "" : "s"})`;
    }
    case "set_program_lock": return i.locked ? "Locking the program" : "Unlocking the program";
    case "log_session": return "Logging a session";
    case "push_to_hevy": {
      const days = Array.isArray(i.dayIds) ? `${i.dayIds.length} day${i.dayIds.length === 1 ? "" : "s"}` : "all days";
      return i.push ? `Pushing ${days} to Hevy` : `Preparing Hevy push (dry run, ${days})`;
    }
    default: return `Running ${name}`;
  }
}

/** Short human summary of a finished tool call for the activity chip. */
export function summarizeOutcome(name: string, outcome: CoachToolOutcome): string {
  if (outcome.isError) {
    const r = outcome.result as { error?: string };
    return r?.error ?? "failed";
  }
  const r = outcome.result as Record<string, unknown>;
  switch (name as CoachToolName) {
    case "update_program": return `${(r.applied as string[]).length} change(s) applied`;
    case "push_to_hevy": {
      if (r.pushed) {
        const w = r.written as { updated: unknown[]; created: unknown[] };
        return `Wrote ${w.updated.length + w.created.length} routine(s) to Hevy`;
      }
      return `Dry run: ${(r.routines as unknown[]).length} routine(s) prepared`;
    }
    case "log_session": return String(r.decision ?? "logged");
    case "set_program_lock": return (r.locked as boolean) ? "Program locked" : "Program unlocked";
    case "get_week_volume": {
      const actual = r.actual as { totalSetsDone?: number } | undefined;
      return typeof actual?.totalSetsDone === "number"
        ? `${r.totalSets} sets planned · ${actual.totalSetsDone} done`
        : "done";
    }
    case "get_hevy_workouts": return `${(r.workouts as unknown[]).length} workout(s)`;
    case "list_hevy_routines": return `${(r.routines as unknown[]).length} routine(s)`;
    default: return "done";
  }
}
