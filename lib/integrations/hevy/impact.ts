import type {
  Exercise,
  MuscleGroup,
  Prescription,
  Program,
  ProgressionDecision,
  SessionResult,
  WeekPlan,
} from "../../engine/types";
import { buildCalendar } from "../../engine/calendar";
import { percentOf1RM } from "../../engine/e1rm";
import { generateWeekPlans } from "../../engine/periodization";
import { prescribe } from "../../engine/prescription";
import { DEFAULT_ROUNDING_KG, DEFAULT_ROUNDING_LB, roundWeight } from "../../engine/rounding";
import { dayWeekView } from "../../engine";
import { progress } from "../../engine/rules";
import { matchProgramToHistory } from "./match";
import { normalizeHistory, type ExerciseHistory } from "./normalize";
import type { HevyExerciseTemplate, HevySet, HevyWorkout } from "./types";

const KG_PER_LB = 0.45359237;

export function fromKg(kg: number, unit: "lb" | "kg"): number {
  return unit === "lb" ? kg / KG_PER_LB : kg;
}

export interface WeeklyChange {
  exerciseId: string;
  exerciseName: string;
  basis: "max" | "work";
  field: "e1rm" | "workWeight" | "hold";
  from: number | null;
  to: number | null;
  note: string;
  /** Sessions of this lift seen in the look-back window. */
  sessions: number;
}

export function roundFor(program: Program, exercise: Exercise, value: number): number {
  return roundWeight(value, exercise.rounding ?? (program.cycle.unit === "kg" ? DEFAULT_ROUNDING_KG : DEFAULT_ROUNDING_LB));
}

/** Build the SessionResult for one exercise from its most recent session in the window. */
export function buildResult(
  program: Program,
  exercise: Exercise,
  hist: ExerciseHistory,
  plan: WeekPlan,
): SessionResult | null {
  const unit = program.cycle.unit;
  const lastDate = hist.perSession[hist.perSession.length - 1]?.date;
  // When RPE wasn't logged, assume a hard set (RPE 9). This is deliberately
  // conservative for unattended pushes and impact previews.
  const ASSUMED_RPE = 9;
  // Max-basis lifts need a weighted set to estimate from; work-basis (incl.
  // bodyweight, weightKg null/0) keep the set so rep-driven rules can advance.
  const sets = hist.workingSets
    .filter((s) => s.date === lastDate && (exercise.loadBasis === "work" || s.weightKg != null))
    .map((s) => ({
      weight: roundFor(program, exercise, fromKg(s.weightKg ?? 0, unit)),
      reps: s.reps,
      rpe: typeof s.rpe === "number" && s.rpe > 0 ? s.rpe : ASSUMED_RPE,
    }));
  if (sets.length === 0) return null;
  return { exerciseId: exercise.id, week: plan.week, sets };
}

/** Cap on weekly UPward movement (safety for unattended pushes); decreases are free. */
export const MAX_WEEKLY_INCREASE = 0.15;

export function applyDecision(
  program: Program,
  exercise: Exercise,
  decision: ProgressionDecision,
  plan: WeekPlan,
): { next: Exercise; change: WeeklyChange } {
  const next: Exercise = { ...exercise };
  let field: WeeklyChange["field"] = "hold";
  let from: number | null = null;
  let to: number | null = null;
  let clamped = false;

  if (exercise.loadBasis === "max" && exercise.e1rm != null) {
    // A max-basis load is re-derived from e1RM, so a rule that emits an absolute
    // load step must be converted into the e1RM bump that actually moves next
    // week's load.
    let delta = decision.e1rmDelta;
    if (delta === 0 && decision.loadDeltaAbs !== 0) {
      const rirCutoff = exercise.rirCap != null ? Math.max(exercise.rirCap, plan.rir) : plan.rir;
      const pct = percentOf1RM(plan.reps, rirCutoff) || 1;
      delta = decision.loadDeltaAbs / pct;
    }
    if (delta !== 0) {
      from = exercise.e1rm;
      let raw = exercise.e1rm + delta;
      const cap = exercise.e1rm * (1 + MAX_WEEKLY_INCREASE);
      if (raw > cap) {
        raw = cap;
        clamped = true;
      }
      next.e1rm = roundFor(program, exercise, raw);
      to = next.e1rm;
      field = next.e1rm !== exercise.e1rm ? "e1rm" : "hold";
    }
  } else if (exercise.loadBasis === "work" && exercise.workWeight != null && decision.loadDeltaAbs !== 0) {
    from = exercise.workWeight;
    next.workWeight = roundFor(program, exercise, exercise.workWeight + decision.loadDeltaAbs);
    to = next.workWeight;
    field = next.workWeight !== exercise.workWeight ? "workWeight" : "hold";
  }

  let note = decision.note;
  if (field === "hold") note = `Held — ${decision.note}`;
  else if (clamped) note = `${decision.note} — capped at +${Math.round(MAX_WEEKLY_INCREASE * 100)}%/week for safety.`;

  return {
    next,
    change: { exerciseId: exercise.id, exerciseName: exercise.name, basis: exercise.loadBasis, field, from, to, note, sessions: 0 },
  };
}

export type WorkoutVerdict = "above" | "on" | "below";
/**
 * "swapped": the planned lift wasn't logged, but an unplanned lift hitting the
 * same muscle group was — the slot is credited with the substitute's sets so
 * the work still counts, while the planned lift's load anchor is held.
 */
export type WorkoutExerciseStatus = "trained" | "swapped" | "skipped";

export interface WorkoutActualSet {
  weight: number | null;
  reps: number;
  rpe: number | null;
  type: string;
}

export interface WorkoutExerciseImpact {
  exercise: Exercise;
  plan: WeekPlan;
  prescription: Prescription;
  templateTitle: string | null;
  actualSets: WorkoutActualSet[];
  status: WorkoutExerciseStatus;
  verdict: WorkoutVerdict;
  decisionNote: string;
  change: WeeklyChange | null;
  nextPrescription: Prescription | null;
}

export interface WorkoutExtraImpact {
  templateId: string;
  title: string;
  /** The template's mapped muscle group (null when Hevy's slug doesn't map). */
  muscle: MuscleGroup | null;
  actualSets: WorkoutActualSet[];
}

export interface WorkoutImpact {
  workoutId: string;
  workoutTitle: string;
  startTime: string;
  week: number;
  day: { id: string; name: string } | null;
  exercises: WorkoutExerciseImpact[];
  extras: WorkoutExtraImpact[];
  skipped: WorkoutExerciseImpact[];
  summary: Record<WorkoutVerdict, number>;
}

export function parseDayIdFromTitle(title: string, program: Program): string | null {
  const ids = new Set(program.days.map((d) => d.id));
  for (const match of title.matchAll(/\[([a-z0-9-]+)\]/gi)) {
    const id = match[1];
    if (ids.has(id)) return id;
  }
  return null;
}

export function parseWeekFromTitle(title: string): number | null {
  const match = title.match(/\bW(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

/**
 * The program week a Hevy workout belongs to: the routine's W-marker when the
 * title carries one, else derived from the block start date; clamped to the
 * calendar. Workouts before this block return null — they remain valid Hevy
 * history, but must never inflate the current block's weekly volume.
 *
 * One shared rule keeps the review page, coach tools, and reports aligned.
 */
export function weekForWorkout(
  workout: Pick<HevyWorkout, "title" | "start_time">,
  startDate: string,
  totalWeeks: number,
): number | null {
  const DAY = 86_400_000;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const at = Date.parse(`${workout.start_time.slice(0, 10)}T00:00:00Z`);
  if (!Number.isNaN(start) && !Number.isNaN(at) && at < start) return null;
  const fromDate = () => {
    if (Number.isNaN(start) || Number.isNaN(at)) return 1;
    return Math.floor((at - start) / (7 * DAY)) + 1;
  };
  const week = parseWeekFromTitle(workout.title) ?? fromDate();
  return Math.max(1, Math.min(totalWeeks, week));
}

export function workoutImpact(
  program: Program,
  workout: HevyWorkout,
  templates: HevyExerciseTemplate[],
  week: number,
): WorkoutImpact {
  const history = normalizeHistory([workout], templates);
  const matches = matchProgramToHistory(program, history);
  const matchById = new Map(matches.map((m) => [m.exerciseId, m]));
  const rawSetsByTemplate = new Map<string, HevySet[]>();
  for (const block of workout.exercises) {
    const sets = rawSetsByTemplate.get(block.exercise_template_id) ?? [];
    sets.push(...block.sets);
    rawSetsByTemplate.set(block.exercise_template_id, sets);
  }
  const matchedDayId = parseDayIdFromTitle(workout.title, program) ?? fallbackDayId(program, matches);
  const day = matchedDayId ? program.days.find((d) => d.id === matchedDayId) ?? null : null;
  const claimedTemplates = new Set<string>();

  const exercises: WorkoutExerciseImpact[] = day
    ? dayWeekView(program, day.id, week).map(({ exercise, plan, prescription }) => {
        const match = matchById.get(exercise.id);
        const hist = match?.templateId ? history.byTemplate.get(match.templateId) : undefined;
        if (hist && match?.templateId) claimedTemplates.add(match.templateId);
        const actualSets = match?.templateId
          ? actualSetsFromHevy(program, exercise, rawSetsByTemplate.get(match.templateId) ?? [])
          : [];

        if (!hist || hist.sessions === 0 || actualSets.length === 0) {
          return {
            exercise,
            plan,
            prescription,
            templateTitle: match?.templateTitle ?? null,
            actualSets: [],
            status: "skipped" as const,
            verdict: "below" as const,
            decisionNote: "Skipped - no matching Hevy sets in this workout.",
            change: null,
            nextPrescription: null,
          };
        }

        if (plan.isDeload) {
          return {
            exercise,
            plan,
            prescription,
            templateTitle: match?.templateTitle ?? hist.title,
            actualSets,
            status: "trained" as const,
            verdict: "on" as const,
            decisionNote: "Deload week - recovery only, no progression applied.",
            change: { exerciseId: exercise.id, exerciseName: exercise.name, basis: exercise.loadBasis, field: "hold" as const, from: null, to: null, note: "Deload week - recovery only, no progression applied.", sessions: hist.sessions },
            nextPrescription: prescription,
          };
        }

        const result = buildResult(program, exercise, hist, plan);
        if (!result) {
          return {
            exercise,
            plan,
            prescription,
            templateTitle: match?.templateTitle ?? hist.title,
            actualSets,
            status: "skipped" as const,
            verdict: "below" as const,
            decisionNote: "Skipped - no weighted working sets available for this rule.",
            change: null,
            nextPrescription: null,
          };
        }

        const decision = progress(exercise, plan, result);
        const { next, change } = applyDecision(program, exercise, decision, plan);
        change.sessions = hist.sessions;
        const nextPrescription = previewNextPrescription(program, next, week, decision);
        return {
          exercise,
          plan,
          prescription,
          templateTitle: match?.templateTitle ?? hist.title,
          actualSets,
          status: "trained" as const,
          verdict: verdictFor(exercise, decision, change),
          decisionNote: change.note,
          change,
          nextPrescription,
        };
      })
    : [];

  // Swap detection: a planned lift with no logged sets may have been traded at
  // the gym for an unplanned lift hitting the same muscle group (dumbbell row →
  // iso-row machine, barbell curl → hammer curl). Credit the slot with the
  // substitute's sets — so the work is tracked and counted in volume — instead
  // of reporting "skipped" plus an unexplained extra. Candidates are ranked by
  // the matcher's alternate scores (movement similarity), then workout order;
  // each substitute covers at most one slot. The planned lift's load anchor is
  // deliberately held: a different movement's weights can't calibrate it.
  for (const row of exercises) {
    if (row.status !== "skipped" || row.actualSets.length > 0) continue;
    const altScore = new Map(
      (matchById.get(row.exercise.id)?.alternates ?? []).map((a) => [a.templateId, a.score] as const),
    );
    const substitute = [...history.byTemplate.values()]
      .filter((h) => !claimedTemplates.has(h.templateId) && h.muscle === row.exercise.muscle)
      .sort((a, b) => (altScore.get(b.templateId) ?? 0) - (altScore.get(a.templateId) ?? 0))[0];
    if (!substitute) continue;
    claimedTemplates.add(substitute.templateId);
    const actualSets = actualSetsFromHevy(program, null, rawSetsByTemplate.get(substitute.templateId) ?? []);
    const workingSets = actualSets.filter((s) => s.type !== "warmup").length;
    row.status = "swapped";
    row.templateTitle = substitute.title;
    row.actualSets = actualSets;
    row.verdict = "on";
    row.decisionNote =
      `Swapped for ${substitute.title} — ${workingSets} working set${workingSets === 1 ? "" : "s"} ` +
      `count toward ${row.exercise.muscle} volume; the planned lift's load is held (different movement).`;
  }

  const extras = [...history.byTemplate.values()]
    .filter((hist) => !claimedTemplates.has(hist.templateId))
    .map((hist) => ({
      templateId: hist.templateId,
      title: hist.title,
      muscle: hist.muscle,
      actualSets: actualSetsFromHevy(program, null, rawSetsByTemplate.get(hist.templateId) ?? []),
    }));

  const summary = { above: 0, on: 0, below: 0 };
  for (const row of exercises) summary[row.verdict] += 1;

  return {
    workoutId: workout.id,
    workoutTitle: workout.title,
    startTime: workout.start_time,
    week,
    day: day ? { id: day.id, name: day.name } : null,
    exercises,
    extras,
    skipped: exercises.filter((e) => e.status === "skipped"),
    summary,
  };
}

function fallbackDayId(program: Program, matches: ReturnType<typeof matchProgramToHistory>): string | null {
  let best: { id: string; count: number } | null = null;
  for (const day of program.days) {
    const ids = new Set(day.exercises.map((e) => e.id));
    const count = matches.filter((m) => ids.has(m.exerciseId) && m.templateId).length;
    if (!best || count > best.count) best = { id: day.id, count };
  }
  return best && best.count >= 2 ? best.id : null;
}

/** Review keeps every rep-based Hevy set visible, including marked warm-ups. */
function actualSetsFromHevy(program: Program, exercise: Exercise | null, sets: HevySet[]): WorkoutActualSet[] {
  return sets.flatMap((set) =>
    typeof set.reps === "number" && set.reps > 0
      ? [{
          weight: set.weight_kg == null ? null : displayWeight(program, exercise, set.weight_kg),
          reps: set.reps,
          rpe: set.rpe,
          type: set.type,
        }]
      : [],
  );
}

function displayWeight(program: Program, exercise: Exercise | null, kg: number): number {
  const converted = fromKg(kg, program.cycle.unit);
  if (exercise) return roundFor(program, exercise, converted);
  return Math.round(converted * 10) / 10;
}

function previewNextPrescription(
  program: Program,
  exercise: Exercise,
  week: number,
  decision: ProgressionDecision,
): Prescription {
  const calendar = buildCalendar(program.cycle);
  const plans = generateWeekPlans(exercise.wave, calendar);
  const currentPlan = plans.find((p) => p.week === week) ?? plans[0];
  const nextPlan = plans.find((p) => p.week === week + 1) ?? currentPlan;
  const next = prescribe(exercise, nextPlan);
  if (decision.repsReset) {
    next.reps = exercise.repTarget ?? nextPlan.reps;
  } else if (decision.repTargetDelta !== 0) {
    const grown = next.reps + decision.repTargetDelta;
    next.reps = exercise.repCap != null ? Math.min(grown, exercise.repCap) : grown;
  }
  return next;
}

function verdictFor(exercise: Exercise, decision: ProgressionDecision, change: WeeklyChange): WorkoutVerdict {
  if (exercise.rule === "calibration" && exercise.e1rm && decision.e1rmDelta !== 0) {
    const pct = decision.e1rmDelta / exercise.e1rm;
    if (pct > 0.025) return "above";
    if (pct < -0.025) return "below";
    return "on";
  }
  if (change.field !== "hold" && change.from != null && change.to != null) {
    if (change.to > change.from) return "above";
    if (change.to < change.from) return "below";
  }
  if (decision.repTargetDelta > 0) return "on";
  if (decision.loadDeltaAbs < 0 || decision.e1rmDelta < 0) return "below";
  if (/only|miss|under|harder|grind|drop/i.test(decision.note)) return "below";
  return "on";
}
