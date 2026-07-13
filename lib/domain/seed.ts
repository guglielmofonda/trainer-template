import type {
  CycleConfig,
  Exercise,
  LoadBasis,
  MuscleGroup,
  Program,
  ProgressionRuleId,
  TrainingDay,
  WaveConfig,
} from "../engine/types";
import { DEFAULT_ROUNDING_LB } from "../engine/rounding";

/**
 * The user's program — in POUNDS — built in two phases:
 *
 *   • rampProgram()  — a 2-week re-acclimation + 1RM-calibration block (run first).
 *   • seedProgram()  — the 21-week 3-day full-body strength + hypertrophy block.
 *
 * Why full-body on 3 days: with weekly volume equated, training frequency is roughly
 * neutral for growth (Schoenfeld/Grgic/Krieger 2019). So on a fixed 3-day week the
 * lever that matters is volume *distribution*: full-body trains each muscle ~3×/week
 * with fresh, quality sets, whereas a push/pull/legs split would strand each muscle at
 * 1×/week. The big barbell lifts (squat / bench / deadlift / press) recur for strength
 * and motor skill ("functionality"); accessories run hypertrophy ranges for size.
 *
 * Estimated starting maxes (lb), refined by the ramp's calibration sets before the
 * main block: squat 185, bench 195, deadlift 275, overhead press 130.
 */

export const SEED_CYCLE: CycleConfig = {
  weeksOn: 6,
  weeksOff: 1,
  mesocycles: 3,
  unit: "lb",
  rounding: DEFAULT_ROUNDING_LB,
};

/** Estimated 1RMs (lb) for the main lifts — placeholders the ramp calibrates. */
const E1RM = { squat: 185, bench: 195, deadlift: 275, press: 130 } as const;
const BARBELL_WARMUP = { profile: "standard", startLoad: 45 } as const;
const DEADLIFT_WARMUP = { profile: "deadlift", startLoad: 75 } as const;
const HINGE_WARMUP = { profile: "deadlift", startLoad: 45 } as const;
const DUMBBELL_PRESS_WARMUP = { profile: "standard", startLoad: 25 } as const;

/**
 * Main-barbell strength wave (max basis). Reps descend 6→3 and RIR 3→1 across the
 * cycle so load climbs, but it tops out at a heavy triple rather than peaking to a
 * true single — strength + skill exposure without a powerlifting peak. (Intensity is
 * display-only for max-basis lifts: their load is e1RM × %1RM(reps, RIR), recalibrated
 * each session by the opening single.)
 */
function strengthWave(over: Partial<WaveConfig> = {}): WaveConfig {
  return {
    goal: "strength",
    shape: "descending-wave",
    waveLength: 3,
    repsStart: 6,
    repsEnd: 3,
    setsStart: 4,
    setsEnd: 3,
    rirStart: 3,
    rirEnd: 1,
    intensityStart: 1.0,
    intensityEnd: 1.1,
    ...over,
  };
}

/**
 * Hypertrophy accessory wave (work basis): flat sets/reps — the progression Rule
 * (double-progression / reps-to-failure) drives the load, not a planned intensity ramp.
 * `reps` is the bottom of the rep bracket; each exercise's `repCap` is the top.
 */
function accessoryWave(reps: number, sets: number, over: Partial<WaveConfig> = {}): WaveConfig {
  return {
    goal: "hypertrophy",
    shape: "flat",
    waveLength: 3,
    repsStart: reps,
    repsEnd: reps,
    setsStart: sets,
    setsEnd: sets,
    rirStart: 2,
    rirEnd: 1,
    intensityStart: 1.0,
    intensityEnd: 1.0,
    ...over,
  };
}

let counter = 0;
function ex(
  name: string,
  muscle: MuscleGroup,
  rule: ProgressionRuleId,
  load: { basis: LoadBasis; e1rm?: number; workWeight?: number },
  wave: WaveConfig,
  extra: Partial<Exercise> = {},
): Exercise {
  counter += 1;
  const compound = ["set-threshold-rir", "five-three-one", "top-set-backoff", "amrap-top-set", "calibration"].includes(rule);
  return {
    id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${counter}`,
    name,
    muscle,
    compound: extra.compound ?? compound,
    usesOpeningSingle: extra.usesOpeningSingle ?? (load.basis === "max" && (extra.compound ?? compound)),
    openingSingleRpe: 8,
    loadBasis: load.basis,
    e1rm: load.e1rm,
    workWeight: load.workWeight,
    rule,
    wave,
    rounding: DEFAULT_ROUNDING_LB,
    ...extra,
  };
}

/**
 * A quick arms dropset finisher (work basis, `drop-set` rule). The full-body
 * guarantee: every training day hits biceps AND triceps, and on a short day these
 * are 2 fast dropsets you can always squeeze in. Appended only to days whose main
 * work doesn't already cover that arm. The Hevy exporter renders `drop-set` lifts
 * as dropset sets; in the app they show with the Drop-set rule and 0 RIR (failure).
 */
function armsFinisher(muscle: "Biceps" | "Triceps"): Exercise {
  const bi = muscle === "Biceps";
  return ex(
    bi ? "Bicep Curl (Dumbbell)" : "Triceps Pushdown",
    muscle,
    "drop-set",
    { basis: "work", workWeight: bi ? 30 : 25 },
    accessoryWave(bi ? 12 : 15, 2, { rirStart: 0, rirEnd: 0 }),
    { repTarget: bi ? 12 : 15, perHand: bi ? true : undefined },
  );
}

/* ===========================================================================
 * MAIN BLOCK — 21-week, 3-day full-body (strength + hypertrophy)
 * NOTE: day-1 index 0 is the main max-basis compound and index 2 is a
 * double-progression work-basis accessory — lib/engine/fixes.test.ts relies on it.
 * Arms finishers are APPENDED (kept off indices 0/2 those tests pin).
 * ======================================================================== */

const day1: TrainingDay = {
  id: "day-1",
  name: "Day 1 · Squat + Bench",
  exercises: [
    ex("Back Squat", "Quadriceps", "set-threshold-rir", { basis: "max", e1rm: E1RM.squat }, strengthWave(), { rirCap: 1.5, warmup: BARBELL_WARMUP }),
    ex("Bench Press", "Chest", "set-threshold-rir", { basis: "max", e1rm: E1RM.bench }, strengthWave({ setsStart: 3 }), { rirCap: 1.5, warmup: BARBELL_WARMUP }),
    ex("Leg Extension", "Quadriceps", "double-progression", { basis: "work", workWeight: 100 }, accessoryWave(12, 3), { repCap: 16 }),
    ex("Chest Supported Row", "Back", "double-progression", { basis: "work", workWeight: 55 }, accessoryWave(10, 4), { repCap: 14, compound: true, perHand: true }),
    ex("Seated Leg Curl", "Hamstrings", "double-progression", { basis: "work", workWeight: 100 }, accessoryWave(12, 3), { repCap: 16 }),
    ex("Lateral Raise", "Shoulders", "double-progression", { basis: "work", workWeight: 20 }, accessoryWave(15, 3), { repCap: 20, perHand: true }),
    ex("Triceps Pushdown", "Triceps", "double-progression", { basis: "work", workWeight: 55 }, accessoryWave(12, 3), { repCap: 16 }),
    ex("Standing Calf Raise", "Calves", "double-progression", { basis: "work", workWeight: 180 }, accessoryWave(10, 3), { repCap: 14 }),
    armsFinisher("Biceps"), // day already has triceps (pushdown) — finish the biceps
    ex("Cable Crunch", "Abs", "double-progression", { basis: "work", workWeight: 70 }, accessoryWave(10, 3), { repCap: 15 }),
  ],
};

const day2: TrainingDay = {
  id: "day-2",
  name: "Day 2 · Deadlift + Press",
  exercises: [
    ex("Deadlift", "Hamstrings", "top-set-backoff", { basis: "max", e1rm: E1RM.deadlift }, strengthWave({ repsStart: 5, setsStart: 3 }), { rirCap: 2, warmup: DEADLIFT_WARMUP }),
    ex("Overhead Press", "Shoulders", "set-threshold-rir", { basis: "max", e1rm: E1RM.press }, strengthWave({ setsStart: 3 }), { rirCap: 1.5, warmup: BARBELL_WARMUP }),
    ex("Weighted Pull-Up", "Back", "double-progression", { basis: "work", workWeight: 0 }, accessoryWave(8, 4), { repCap: 12, compound: true }),
    ex("Leg Press", "Quadriceps", "double-progression", { basis: "work", workWeight: 310 }, accessoryWave(12, 3), { repCap: 16, compound: true }),
    ex("Incline DB Press", "Chest", "double-progression", { basis: "work", workWeight: 60 }, accessoryWave(10, 4), { repCap: 14, perHand: true, warmup: DUMBBELL_PRESS_WARMUP }),
    ex("Barbell Curl", "Biceps", "double-progression", { basis: "work", workWeight: 65 }, accessoryWave(10, 4), { repCap: 14 }),
    ex("Seated Calf Raise", "Calves", "double-progression", { basis: "work", workWeight: 100 }, accessoryWave(12, 3), { repCap: 16 }),
    ex("Hanging Leg Raise", "Abs", "double-progression", { basis: "work", workWeight: 0 }, accessoryWave(12, 3), { repCap: 20 }),
    armsFinisher("Triceps"), // day already has biceps (barbell curl) — finish the triceps
  ],
};

const day3: TrainingDay = {
  id: "day-3",
  name: "Day 3 · Full-Body Hypertrophy",
  exercises: [
    ex("Bulgarian Split Squat", "Quadriceps", "double-progression", { basis: "work", workWeight: 35 }, accessoryWave(10, 3), { repCap: 14, compound: true, perHand: true }),
    ex("Romanian Deadlift", "Hamstrings", "double-progression", { basis: "work", workWeight: 155 }, accessoryWave(10, 3), { repCap: 14, compound: true, warmup: HINGE_WARMUP }),
    ex("Incline Bench Press", "Chest", "double-progression", { basis: "work", workWeight: 120 }, accessoryWave(8, 4), { repCap: 12, compound: true, warmup: BARBELL_WARMUP }),
    ex("Lat Pulldown", "Back", "double-progression", { basis: "work", workWeight: 120 }, accessoryWave(12, 4), { repCap: 16 }),
    ex("Hip Thrust", "Glutes", "double-progression", { basis: "work", workWeight: 200 }, accessoryWave(12, 4), { repCap: 16, compound: true, warmup: BARBELL_WARMUP }),
    ex("Rear Delt Fly", "Shoulders", "reps-to-failure", { basis: "work", workWeight: 25 }, accessoryWave(15, 3), { repTarget: 15 }),
    ex("Overhead Triceps Extension", "Triceps", "double-progression", { basis: "work", workWeight: 55 }, accessoryWave(12, 3), { repCap: 16 }),
    ex("Hammer Curl", "Biceps", "double-progression", { basis: "work", workWeight: 30 }, accessoryWave(12, 4), { repCap: 16, perHand: true }),
    ex("Standing Calf Raise", "Calves", "double-progression", { basis: "work", workWeight: 180 }, accessoryWave(10, 3), { repCap: 14 }),
    ex("Decline Crunch", "Abs", "double-progression", { basis: "work", workWeight: 0 }, accessoryWave(12, 3), { repCap: 20 }),
  ],
};

export function seedProgram(): Program {
  counter = 0;
  return {
    id: "full-body-3x",
    name: "Full-Body 3× — Strength + Hypertrophy block",
    cycle: SEED_CYCLE,
    days: [day1, day2, day3],
    locked: false,
  };
}

export const SEED_PROGRAM: Program = seedProgram();

/* ===========================================================================
 * PHASE 0 — 2-WEEK RAMP-UP & CALIBRATION (run this first)
 *
 * Returning from a layoff with unknown maxes: this block re-grooves the patterns,
 * loads joints/tendons submaximally (connective tissue remodels slower than muscle),
 * and — crucially — *estimates* each 1RM from RPE-rated sets instead of testing one.
 *
 * The four main lifts use the `calibration` rule on a submaximal wave that goes from
 * ~3×8 @ RPE 6 (week 1) to ~3×5 @ RPE 7 (week 2). You log the actual RPE; the engine
 * back-calculates e1RM (Zourdos/Helms RPE→%1RM). After two weeks you carry the dialed-in
 * numbers into the main block. Volume is intentionally LOW — this is adaptation, not
 * growth, so several muscles sit at *maintenance* (below MEV); that's expected for a ramp.
 * ======================================================================== */

export const RAMP_CYCLE: CycleConfig = {
  weeksOn: 2,
  weeksOff: 0,
  mesocycles: 1,
  unit: "lb",
  rounding: DEFAULT_ROUNDING_LB,
};

/**
 * Ramp wave (max basis, calibration rule). waveLength 1 makes each week its own step:
 * week 1 = 8 reps @ 4 RIR (RPE 6, ~70% — gentle tendon load), week 2 = 5 reps @ 2 RIR
 * (RPE 8, ~80% — the reliable calibration point). No opening singles in the ramp.
 */
function rampWave(over: Partial<WaveConfig> = {}): WaveConfig {
  return {
    goal: "strength",
    shape: "descending-wave",
    waveLength: 1,
    repsStart: 8,
    repsEnd: 5,
    setsStart: 3,
    setsEnd: 3,
    rirStart: 4,
    rirEnd: 2,
    intensityStart: 1.0,
    intensityEnd: 1.0,
    ...over,
  };
}

/** Submaximal accessory wave for the ramp — higher RIR, fewer sets than the main block. */
function rampAccessory(reps: number, sets: number, over: Partial<WaveConfig> = {}): WaveConfig {
  return accessoryWave(reps, sets, { rirStart: 4, rirEnd: 3, ...over });
}

const rampDay1: TrainingDay = {
  id: "ramp-day-1",
  name: "Ramp Day 1 · Squat + Bench",
  exercises: [
    ex("Back Squat", "Quadriceps", "calibration", { basis: "max", e1rm: E1RM.squat }, rampWave(), { compound: true, usesOpeningSingle: false, warmup: BARBELL_WARMUP }),
    ex("Bench Press", "Chest", "calibration", { basis: "max", e1rm: E1RM.bench }, rampWave(), { compound: true, usesOpeningSingle: false, warmup: BARBELL_WARMUP }),
    ex("Chest Supported Row", "Back", "double-progression", { basis: "work", workWeight: 50 }, rampAccessory(12, 3), { repCap: 15, perHand: true }),
    ex("Seated Leg Curl", "Hamstrings", "double-progression", { basis: "work", workWeight: 125 }, rampAccessory(12, 2), { repCap: 15 }),
    ex("Lateral Raise", "Shoulders", "double-progression", { basis: "work", workWeight: 20 }, rampAccessory(15, 3), { repCap: 20, perHand: true }),
    armsFinisher("Biceps"), // no direct arms on this day — finish both
    armsFinisher("Triceps"),
    ex("Standing Calf Raise", "Calves", "double-progression", { basis: "work", workWeight: 180 }, rampAccessory(10, 3), { repCap: 15 }),
    ex("Cable Crunch", "Abs", "double-progression", { basis: "work", workWeight: 70 }, rampAccessory(10, 3), { repCap: 15 }),
  ],
};

const rampDay2: TrainingDay = {
  id: "ramp-day-2",
  name: "Ramp Day 2 · Deadlift + Press",
  exercises: [
    // Deadlift stays lower-rep even in the ramp — high fatigue/skill cost when detrained.
    ex("Deadlift", "Hamstrings", "calibration", { basis: "max", e1rm: E1RM.deadlift }, rampWave({ repsStart: 5, repsEnd: 4, rirStart: 4, rirEnd: 3 }), { compound: true, usesOpeningSingle: false, warmup: DEADLIFT_WARMUP }),
    ex("Overhead Press", "Shoulders", "calibration", { basis: "max", e1rm: E1RM.press }, rampWave(), { compound: true, usesOpeningSingle: false, warmup: BARBELL_WARMUP }),
    ex("Incline DB Press", "Chest", "double-progression", { basis: "work", workWeight: 60 }, rampAccessory(12, 3), { repCap: 15, perHand: true, warmup: DUMBBELL_PRESS_WARMUP }),
    ex("Lat Pulldown", "Back", "double-progression", { basis: "work", workWeight: 110 }, rampAccessory(12, 3), { repCap: 15 }),
    ex("Leg Press", "Quadriceps", "double-progression", { basis: "work", workWeight: 265 }, rampAccessory(12, 3), { repCap: 15 }),
    ex("Barbell Curl", "Biceps", "double-progression", { basis: "work", workWeight: 55 }, rampAccessory(12, 3), { repCap: 15 }),
    armsFinisher("Triceps"), // day already has biceps (barbell curl)
    ex("Seated Calf Raise", "Calves", "double-progression", { basis: "work", workWeight: 100 }, rampAccessory(12, 3), { repCap: 16 }),
    ex("Hanging Leg Raise", "Abs", "double-progression", { basis: "work", workWeight: 0 }, rampAccessory(10, 3), { repCap: 20 }),
  ],
};

const rampDay3: TrainingDay = {
  id: "ramp-day-3",
  name: "Ramp Day 3 · Technique + Volume",
  exercises: [
    // Variations (work basis) so the main lifts keep a single clean calibration track.
    ex("Front Squat", "Quadriceps", "double-progression", { basis: "work", workWeight: 110 }, rampAccessory(8, 3), { repCap: 10, compound: true, warmup: BARBELL_WARMUP }),
    ex("Incline Bench Press", "Chest", "double-progression", { basis: "work", workWeight: 110 }, rampAccessory(10, 3), { repCap: 12, compound: true, warmup: BARBELL_WARMUP }),
    ex("Romanian Deadlift", "Hamstrings", "double-progression", { basis: "work", workWeight: 130 }, rampAccessory(10, 3), { repCap: 12, compound: true, warmup: HINGE_WARMUP }),
    ex("Chest Supported Row", "Back", "double-progression", { basis: "work", workWeight: 50 }, rampAccessory(12, 3), { repCap: 15, perHand: true }),
    ex("Hip Thrust", "Glutes", "double-progression", { basis: "work", workWeight: 155 }, rampAccessory(12, 3), { repCap: 15, compound: true, warmup: BARBELL_WARMUP }),
    ex("Rear Delt Fly", "Shoulders", "double-progression", { basis: "work", workWeight: 25 }, rampAccessory(15, 3), { repCap: 20 }),
    ex("Hammer Curl", "Biceps", "double-progression", { basis: "work", workWeight: 30 }, rampAccessory(12, 3), { repCap: 16, perHand: true }),
    armsFinisher("Triceps"), // day already has biceps (hammer curl)
    ex("Standing Calf Raise", "Calves", "double-progression", { basis: "work", workWeight: 180 }, rampAccessory(10, 3), { repCap: 15 }),
    ex("Decline Crunch", "Abs", "double-progression", { basis: "work", workWeight: 0 }, rampAccessory(12, 3), { repCap: 20 }),
  ],
};

export function rampProgram(): Program {
  counter = 0;
  return {
    id: "ramp-2wk",
    name: "Ramp-Up & Calibration — 2-week intro",
    cycle: RAMP_CYCLE,
    days: [rampDay1, rampDay2, rampDay3],
    locked: false,
  };
}

export const RAMP_PROGRAM: Program = rampProgram();
