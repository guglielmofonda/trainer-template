/**
 * Core domain types for the periodization + progression engine.
 *
 * The engine is intentionally *pure* (no I/O, no framework deps) so the training
 * theory it encodes is testable in isolation and portable to any backend.
 *
 * Vocabulary (see docs/THEORY.md for the full rationale):
 *  - RPE  : Rate of Perceived Exertion, 1..10. RPE 10 = momentary muscular failure.
 *  - RIR  : Reps In Reserve = 10 - RPE. "Stop with 2 reps left" = RIR 2 = RPE 8.
 *  - e1RM : estimated 1-rep max, inferred from a (weight, reps, rpe) data point.
 *  - Wave : a periodization template that turns one exercise into a week-by-week plan.
 *  - Rule : a progression algorithm that turns *what happened* into *what's next*.
 */

export type WeightUnit = "lb" | "kg";

/** How an exercise's working weight is anchored. */
export type LoadBasis =
  /** Working weight is derived as a % of the estimated 1RM (autoregulated by RPE). */
  | "max"
  /** Working weight is an absolute number we progress directly (accessories). */
  | "work";

export type MuscleGroup =
  | "Quadriceps"
  | "Hamstrings"
  | "Glutes"
  | "Chest"
  | "Back"
  | "Shoulders"
  | "Biceps"
  | "Triceps"
  | "Calves"
  | "Abs"
  | "Forearms";

export type TrainingGoal = "strength" | "hypertrophy" | "peaking";

/** The shape of the within-cycle load curve. */
export type WaveShape =
  /** Sawtooth: reps fall / intensity climbs within each micro-wave, then resets up a notch. */
  | "descending-wave"
  /** Straight ramp: every week a touch harder than the last. */
  | "linear-ramp"
  /** Block: hold a rep bracket for the whole meso, step between mesos. */
  | "step"
  /** Same prescription every week (volume/skill phases). */
  | "flat";

/** Identifiers for the progression algorithms. Mirrors the dropdown in the source app. */
export type ProgressionRuleId =
  | "set-threshold-rir"
  | "last-set-rir"
  | "reps-to-failure"
  | "double-progression"
  | "linear"
  | "amrap-top-set"
  | "five-three-one"
  | "top-set-backoff"
  | "compound-hypertrophy"
  | "drop-set"
  | "calibration";

export type RoundingMode = "nearest" | "floor" | "ceil";

export interface RoundingConfig {
  /** Smallest weight step you can actually load (e.g. 5 lb, 2.5 kg). */
  increment: number;
  mode: RoundingMode;
}

/** The high-level cycle skeleton: "6 on / 1 off · 3 mesos" → 21 weeks. */
export interface CycleConfig {
  /** Training weeks per mesocycle. */
  weeksOn: number;
  /** Deload weeks per mesocycle (placed at the end of each meso). */
  weeksOff: number;
  /** Number of mesocycles. */
  mesocycles: number;
  unit: WeightUnit;
  rounding: RoundingConfig;
}

/** Periodization template attached to an exercise. */
export interface WaveConfig {
  goal: TrainingGoal;
  shape: WaveShape;
  /** Length of one micro-wave in weeks (the sawtooth period). Default 3. */
  waveLength: number;
  repsStart: number;
  repsEnd: number;
  setsStart: number;
  setsEnd: number;
  /** RIR at the easiest week. */
  rirStart: number;
  /** RIR at the hardest week. */
  rirEnd: number;
  /** Planned-load multiplier at week 1 (relative to the exercise's reference load). */
  intensityStart: number;
  /** Planned-load multiplier at the final training week. */
  intensityEnd: number;
}

/** Exercise-specific ramp used before the first working rep. */
export interface WarmupConfig {
  /** Standard keeps a little more rehearsal volume; deadlift keeps reps lower. */
  profile: "standard" | "deadlift";
  /** First load in the program's unit (45 lb bar, or 95 lb for deadlift). */
  startLoad: number;
}

/** A single exercise slot inside a training day. */
export interface Exercise {
  id: string;
  name: string;
  muscle: MuscleGroup;
  /** Compound lift (multi-joint). Drives default rounding & autoregulation behavior. */
  compound: boolean;
  /** Uses an "opening single @RPE" to recalibrate e1RM each session. */
  usesOpeningSingle: boolean;
  /** Target RPE for the opening single (typically 8). */
  openingSingleRpe: number;
  /** Progressive, movement-specific sets that never count as working volume. */
  warmup?: WarmupConfig;
  loadBasis: LoadBasis;
  /** Estimated 1RM, used when loadBasis === "max". */
  e1rm?: number;
  /** Absolute working weight, used when loadBasis === "work". */
  workWeight?: number;
  /** Load is per dumbbell/hand, matching Hevy logging; display-only, engine math unaffected. */
  perHand?: boolean;
  rule: ProgressionRuleId;
  wave: WaveConfig;
  /** Optional per-exercise rounding override. */
  rounding?: RoundingConfig;
  /** Rep ceiling for double-progression style rules. */
  repCap?: number;
  /** Rep floor / target for failure & top-set rules. */
  repTarget?: number;
  /** RIR cutoff for set-threshold style rules (overrides the wave RIR if set). */
  rirCap?: number;
}

export interface TrainingDay {
  id: string;
  name: string;
  exercises: Exercise[];
}

export interface Program {
  id: string;
  name: string;
  cycle: CycleConfig;
  days: TrainingDay[];
  /** Once locked, the configuration is frozen and only logging happens. */
  locked: boolean;
}

/** A resolved week in the calendar with its meso/deload metadata. */
export interface CalendarWeek {
  /** 1-based global week index. */
  week: number;
  meso: number;
  weekInMeso: number;
  isDeload: boolean;
  label: string; // e.g. "M1 W4"
}

/** One exercise's prescription for one week, produced by the periodization engine. */
export interface WeekPlan {
  week: number;
  isDeload: boolean;
  reps: number;
  sets: number;
  /** Target reps-in-reserve for the work sets. */
  rir: number;
  /** Planned-load multiplier for the week (the macro ramp). */
  intensity: number;
}

/** A concrete, loggable prescription (weight + targets) for a session. */
export interface Prescription {
  exerciseId: string;
  week: number;
  load: number;
  reps: number;
  sets: number;
  rirCutoff: number;
  /** For "max" basis lifts, the e1RM this prescription was derived from. */
  basisE1rm?: number;
  /** Opening single suggestion for @RPE lifts. */
  openingSingle?: { weight: number; rpe: number };
  /** Explicit warm-up sets, ordered light to heavy and excluded from work volume. */
  warmupSets: WarmupSet[];
  notes: string[];
}

export interface WarmupSet {
  load: number;
  reps: number;
}

/** A single logged set. */
export interface LoggedSet {
  weight: number;
  reps: number;
  /** Actual RPE the lifter reported (1..10). */
  rpe: number;
}

/** What actually happened in a session, fed back into the progression rule. */
export interface SessionResult {
  exerciseId: string;
  week: number;
  /** Optional opening single the lifter worked up to. */
  openingSingle?: { weight: number; rpe: number };
  /** The work sets performed. */
  sets: LoggedSet[];
  /**
   * For set-threshold rules: how many quality sets were completed before
   * the lifter hit the RIR cutoff. Equivalent to sets.length when fully logged.
   */
  setsCompleted?: number;
}

/** The recommendation a progression rule emits for the next session/week. */
export interface ProgressionDecision {
  /** Absolute change in working load (engine rounds it). */
  loadDeltaAbs: number;
  /** Change to the rep target (e.g., double progression grows reps). */
  repTargetDelta: number;
  /** Change to the estimated 1RM (autoregulation updates the basis). */
  e1rmDelta: number;
  /** Whether reps reset to the bottom of the bracket (after a load bump). */
  repsReset: boolean;
  /** Human-readable explanation (shown in the UI and used by the coach). */
  note: string;
}
