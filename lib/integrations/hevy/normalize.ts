/**
 * Normalize raw Hevy workouts into per-exercise performance histories.
 *
 * PURE: no I/O, no clock. The caller passes a reference `now` (ISO) so the
 * windowing is deterministic and testable — same discipline the engine uses
 * (it never reads the clock itself). This is where snake_case stops: everything
 * downstream speaks the engine's vocabulary.
 *
 * A "working set" is any non-warmup set with a positive rep count. We keep the
 * raw datapoints (weight, reps, rpe, type, date) and per-session rollups; the
 * e1RM/statistics policy lives in `calibrate.ts` so it can be tuned.
 */
import type { MuscleGroup } from "../../engine/types";
import type { HevyExerciseTemplate, HevySetType, HevyWorkout } from "./types";

export interface WorkingSet {
  /** Workout start time (ISO). */
  date: string;
  /** Kilograms, or null for bodyweight / non-weighted sets. */
  weightKg: number | null;
  reps: number;
  rpe: number | null;
  type: HevySetType;
}

export interface SessionRollup {
  date: string;
  workoutId: string;
  /** Count of working sets of this exercise in the session. */
  sets: number;
  /** Heaviest working-set weight in the session (kg), null if all bodyweight. */
  topWeightKg: number | null;
  /** Reps performed on that heaviest set (ties → most reps). */
  topReps: number;
  topRpe: number | null;
}

export interface ExerciseHistory {
  templateId: string;
  /** Human title (from the template catalog, falling back to the logged title). */
  title: string;
  /** Hevy exercise type, e.g. "weight_reps", "bodyweight_reps". */
  hevyType?: string;
  /** Hevy primary muscle slug, e.g. "quadriceps". */
  primaryMuscle?: string;
  /** Mapped to the engine's MuscleGroup, or null if it doesn't map. */
  muscle: MuscleGroup | null;
  isCustom: boolean;
  /** Distinct workouts containing this exercise (within the window). */
  sessions: number;
  /** Oldest / newest session date considered (ISO). */
  firstDate: string;
  lastDate: string;
  /** Every working set, oldest → newest. */
  workingSets: WorkingSet[];
  /** One rollup per session, oldest → newest. */
  perSession: SessionRollup[];
}

export interface NormalizedHistory {
  byTemplate: Map<string, ExerciseHistory>;
  windowDays: number | null;
  /** Workouts that fell inside the window and were folded in. */
  workoutsConsidered: number;
  /** Date span of the considered workouts. */
  dateRange: { from: string; to: string } | null;
}

export interface NormalizeOptions {
  /** Only consider workouts within this many days of `now`. Omit = all history. */
  windowDays?: number;
  /** Reference "today" (ISO). Required when windowDays is set; engine stays clock-free. */
  now?: string;
}

/** Map Hevy's muscle slug to the engine's MuscleGroup (null when it doesn't fit). */
export function hevyMuscleToGroup(slug: string | undefined): MuscleGroup | null {
  switch ((slug ?? "").toLowerCase()) {
    case "chest":
      return "Chest";
    case "lats":
    case "upper_back":
    case "lower_back":
    case "traps":
      return "Back";
    case "quadriceps":
      return "Quadriceps";
    case "hamstrings":
      return "Hamstrings";
    case "glutes":
      return "Glutes";
    case "shoulders":
      return "Shoulders";
    case "biceps":
      return "Biceps";
    case "triceps":
      return "Triceps";
    case "calves":
      return "Calves";
    case "abdominals":
    case "abs":
      return "Abs";
    case "forearms":
      return "Forearms";
    default:
      return null;
  }
}

function isWorkingSet(type: HevySetType, reps: number | null): reps is number {
  return type !== "warmup" && typeof reps === "number" && reps > 0;
}

export function normalizeHistory(
  workouts: HevyWorkout[],
  templates: HevyExerciseTemplate[],
  opts: NormalizeOptions = {},
): NormalizedHistory {
  const templateById = new Map(templates.map((t) => [t.id, t]));
  const cutoffMs =
    opts.windowDays != null && opts.now
      ? Date.parse(opts.now) - opts.windowDays * 86_400_000
      : NaN;

  const byTemplate = new Map<string, ExerciseHistory>();
  let workoutsConsidered = 0;
  let from = Infinity;
  let to = -Infinity;

  for (const workout of workouts) {
    const startMs = Date.parse(workout.start_time);
    if (!Number.isNaN(cutoffMs) && startMs < cutoffMs) continue;
    workoutsConsidered++;
    if (startMs < from) from = startMs;
    if (startMs > to) to = startMs;

    // Hevy lets the same exercise appear as several blocks in one workout (main +
    // back-off / myo-rep work, or accidental duplicates). Group blocks by template
    // so a workout counts as exactly ONE session per exercise — otherwise a single
    // workout would inflate the session count and fake a high-confidence calibration.
    const blocksByTemplate = new Map<string, typeof workout.exercises>();
    for (const exercise of workout.exercises) {
      const arr = blocksByTemplate.get(exercise.exercise_template_id) ?? [];
      arr.push(exercise);
      blocksByTemplate.set(exercise.exercise_template_id, arr);
    }

    for (const [id, blocks] of blocksByTemplate) {
      const working = blocks.flatMap((b) => b.sets.filter((s) => isWorkingSet(s.type, s.reps)));
      if (working.length === 0) continue;

      let hist = byTemplate.get(id);
      if (!hist) {
        const tpl = templateById.get(id);
        hist = {
          templateId: id,
          title: tpl?.title ?? blocks[0].title,
          hevyType: tpl?.type,
          primaryMuscle: tpl?.primary_muscle_group,
          muscle: hevyMuscleToGroup(tpl?.primary_muscle_group),
          isCustom: tpl?.is_custom ?? false,
          sessions: 0,
          firstDate: workout.start_time,
          lastDate: workout.start_time,
          workingSets: [],
          perSession: [],
        };
        byTemplate.set(id, hist);
      }

      hist.sessions++;
      // One rollup for the whole workout: heaviest working set across all blocks
      // (ties broken by most reps), and the total working-set count.
      let top: SessionRollup = {
        date: workout.start_time,
        workoutId: workout.id,
        sets: working.length,
        topWeightKg: null,
        topReps: 0,
        topRpe: null,
      };
      for (const s of working) {
        const reps = s.reps as number;
        hist.workingSets.push({
          date: workout.start_time,
          weightKg: s.weight_kg,
          reps,
          rpe: s.rpe,
          type: s.type,
        });
        const w = s.weight_kg ?? 0;
        const topW = top.topWeightKg ?? 0;
        if (w > topW || (w === topW && reps > top.topReps)) {
          top = { ...top, topWeightKg: s.weight_kg, topReps: reps, topRpe: s.rpe };
        }
      }
      hist.perSession.push(top);
    }
  }

  // Sort each history chronologically and pin the date span.
  for (const hist of byTemplate.values()) {
    hist.workingSets.sort((a, b) => a.date.localeCompare(b.date));
    hist.perSession.sort((a, b) => a.date.localeCompare(b.date));
    hist.firstDate = hist.perSession[0]?.date ?? hist.firstDate;
    hist.lastDate = hist.perSession[hist.perSession.length - 1]?.date ?? hist.lastDate;
  }

  return {
    byTemplate,
    // Report the window only when it was actually enforced (needs both windowDays
    // and a reference `now`); otherwise null, so downstream math doesn't trust a
    // window that was never applied.
    windowDays: Number.isNaN(cutoffMs) ? null : (opts.windowDays ?? null),
    workoutsConsidered,
    dateRange:
      workoutsConsidered > 0
        ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
        : null,
  };
}
