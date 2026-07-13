/**
 * Periodization + autoregulated-progression engine — public surface.
 *
 * This is the "core bit": a pure, framework-free library that encodes the
 * training theory. Everything else (Next.js UI, persistence, the AI coach) is a
 * thin shell around it. See docs/THEORY.md for the why.
 */
export * from "./types";
export * from "./e1rm";
export * from "./rounding";
export * from "./calendar";
export * from "./periodization";
export * from "./prescription";
export * from "./warmup";
export * from "./analysis";
export { RULES, RULE_META, getRule, progress } from "./rules";
export type { ProgressionRule, ProgressionInput, RuleMeta } from "./rules";

import type {
  Exercise,
  Prescription,
  Program,
  SessionResult,
  WeekPlan,
} from "./types";
import { buildCalendar } from "./calendar";
import { generateWeekPlans } from "./periodization";
import { prescribe, type PrescribeOptions } from "./prescription";
import { progress } from "./rules";

/** The plan + concrete prescription for one exercise on one week. */
export interface ExerciseWeekView {
  exercise: Exercise;
  plan: WeekPlan;
  prescription: Prescription;
}

/** Build the full week view for a day, optionally folding in today's opening singles. */
export function dayWeekView(
  program: Program,
  dayId: string,
  week: number,
  singles: Record<string, { weight: number; rpe: number }> = {},
): ExerciseWeekView[] {
  const calendar = buildCalendar(program.cycle);
  const day = program.days.find((d) => d.id === dayId);
  if (!day) return [];
  return day.exercises.map((exercise) => {
    const plans = generateWeekPlans(exercise.wave, calendar);
    const plan = plans.find((p) => p.week === week) ?? plans[0];
    const opts: PrescribeOptions = singles[exercise.id]
      ? { openingSingle: singles[exercise.id] }
      : {};
    return { exercise, plan, prescription: prescribe(exercise, plan, opts) };
  });
}

/** Apply a logged session to an exercise and produce the next prescription preview. */
export function applySession(
  program: Program,
  exercise: Exercise,
  week: number,
  result: SessionResult,
): { decision: ReturnType<typeof progress>; nextPreview: Prescription } {
  const calendar = buildCalendar(program.cycle);
  const plans = generateWeekPlans(exercise.wave, calendar);
  const thisPlan = plans.find((p) => p.week === week) ?? plans[0];
  const nextPlan = plans.find((p) => p.week === week + 1) ?? thisPlan;
  const single = result.openingSingle ? { openingSingle: result.openingSingle } : {};

  // Deload weeks are intentional recovery — they don't feed progression. Hold.
  if (thisPlan.isDeload) {
    const decision = {
      loadDeltaAbs: 0,
      repTargetDelta: 0,
      e1rmDelta: 0,
      repsReset: false,
      note: "Deload week — recovery only, no progression applied.",
    };
    const nextPreview = prescribe(exercise, nextPlan, single);
    nextPreview.notes = [decision.note, ...nextPreview.notes];
    return { decision, nextPreview };
  }

  const decision = progress(exercise, thisPlan, result);

  // Fold the decision into a forward-looking exercise to preview next week.
  const nextExercise: Exercise = {
    ...exercise,
    e1rm: exercise.e1rm != null ? exercise.e1rm + decision.e1rmDelta : exercise.e1rm,
    workWeight:
      exercise.workWeight != null ? exercise.workWeight + decision.loadDeltaAbs : exercise.workWeight,
  };
  const nextPreview = prescribe(nextExercise, nextPlan, single);

  // For max-basis lifts the load is re-derived from e1rm; only apply an absolute
  // load delta when the e1rm channel didn't already move it (avoids double-counting).
  if (exercise.loadBasis === "max" && decision.loadDeltaAbs !== 0 && decision.e1rmDelta === 0) {
    nextPreview.load += decision.loadDeltaAbs;
  }

  // Honor the rep decision in the preview so it agrees with the note.
  if (decision.repsReset) {
    nextPreview.reps = exercise.repTarget ?? nextPlan.reps;
  } else if (decision.repTargetDelta !== 0) {
    const grown = nextPreview.reps + decision.repTargetDelta;
    nextPreview.reps = exercise.repCap != null ? Math.min(grown, exercise.repCap) : grown;
  }

  nextPreview.notes = [decision.note, ...nextPreview.notes];
  return { decision, nextPreview };
}
