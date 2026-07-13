import type {
  Exercise,
  ProgressionDecision,
  ProgressionRuleId,
  SessionResult,
  WeekPlan,
} from "../types";
import { estimate1RM, rirFromRpe } from "../e1rm";
import { RULE_META, type RuleMeta } from "./metadata";

/* ----------------------------------------------------------------------------
 * Progression rules: given what actually happened in a session, decide what the
 * next session/week should do. Each rule is a small, named, evidence-grounded
 * policy. The metadata (RULE_META) is the lifter-facing rationale.
 * ------------------------------------------------------------------------- */

export interface ProgressionInput {
  exercise: Exercise;
  plan: WeekPlan;
  result: SessionResult;
}

export interface ProgressionRule {
  meta: RuleMeta;
  next(input: ProgressionInput): ProgressionDecision;
}

const NO_CHANGE: ProgressionDecision = {
  loadDeltaAbs: 0,
  repTargetDelta: 0,
  e1rmDelta: 0,
  repsReset: false,
  note: "Hold — repeat the prescription.",
};

/** Base load step. Compounds jump in bigger absolute increments than accessories. */
function step(exercise: Exercise): number {
  const inc = exercise.rounding?.increment ?? 5;
  return exercise.compound ? inc * 2 : inc; // +10 / +5 lb by default
}

/** Sets that reached the rep target at or above the RIR cutoff. */
function qualitySets(input: ProgressionInput): number {
  const { result, plan, exercise } = input;
  if (typeof result.setsCompleted === "number") return result.setsCompleted;
  // Mirror the prescription's rirCap-as-floor semantics (never below the cap).
  const cutoff = exercise.rirCap != null ? Math.max(exercise.rirCap, plan.rir) : plan.rir;
  return result.sets.filter((s) => s.reps >= plan.reps && rirFromRpe(s.rpe) >= cutoff - 0.25)
    .length;
}

function topSet(result: SessionResult) {
  return result.sets.reduce(
    (best, s) => (s.weight * (1 + s.reps / 30) > best.weight * (1 + best.reps / 30) ? s : best),
    result.sets[0],
  );
}

// --- Individual rules -------------------------------------------------------

const setThresholdRir: ProgressionRule["next"] = (input) => {
  const { exercise, plan } = input;
  const done = qualitySets(input);
  const target = plan.sets;
  const s = step(exercise);
  if (done >= target) {
    return {
      loadDeltaAbs: s,
      repTargetDelta: 0,
      e1rmDelta: 0,
      repsReset: true,
      note: `Completed ${done}/${target} quality sets before the RIR cutoff → +${s} next week, reps reset.`,
    };
  }
  return {
    ...NO_CHANGE,
    note: `Only ${done}/${target} quality sets → hold the load and repeat next week.`,
  };
};

const lastSetRir: ProgressionRule["next"] = (input) => {
  const { exercise, plan, result } = input;
  const last = result.sets[result.sets.length - 1];
  if (!last) return NO_CHANGE;
  const cutoff = exercise.rirCap ?? plan.rir;
  const rir = rirFromRpe(last.rpe);
  const s = step(exercise);
  if (rir >= cutoff + 1) {
    return { loadDeltaAbs: s * 2, repTargetDelta: 0, e1rmDelta: 0, repsReset: false, note: `Last set had ${rir} RIR (well under target) → +${s * 2}.` };
  }
  if (rir >= cutoff - 0.5) {
    return { loadDeltaAbs: s, repTargetDelta: 0, e1rmDelta: 0, repsReset: false, note: `Last set on target (${rir} RIR) → +${s}.` };
  }
  return { ...NO_CHANGE, note: `Last set was harder than planned (${rir} RIR) → hold the load.` };
};

const repsToFailure: ProgressionRule["next"] = (input) => {
  const { exercise, plan, result } = input;
  const last = result.sets[result.sets.length - 1];
  if (!last) return NO_CHANGE;
  const target = exercise.repTarget ?? plan.reps;
  const extra = last.reps - target;
  const s = step(exercise);
  const e1rmDelta = estimate1RM(last.weight, last.reps, 10) - (exercise.e1rm ?? estimate1RM(last.weight, last.reps, 10));
  if (extra >= 2) return { loadDeltaAbs: s * 2, repTargetDelta: 0, e1rmDelta, repsReset: false, note: `Failure set beat target by ${extra} reps → +${s * 2}.` };
  if (extra >= 0) return { loadDeltaAbs: s, repTargetDelta: 0, e1rmDelta, repsReset: false, note: `Hit the target on the failure set → +${s}.` };
  return { loadDeltaAbs: -s, repTargetDelta: 0, e1rmDelta, repsReset: false, note: `Missed target by ${-extra} → drop ${s} and rebuild.` };
};

const doubleProgression: ProgressionRule["next"] = (input) => {
  const { exercise, plan, result } = input;
  const cap = exercise.repCap ?? plan.reps + 3;
  const allHitCap = result.sets.length >= plan.sets && result.sets.every((s) => s.reps >= cap);
  const s = step(exercise);
  if (allHitCap) {
    return { loadDeltaAbs: s, repTargetDelta: 0, e1rmDelta: 0, repsReset: true, note: `Every set hit the rep cap (${cap}) → +${s}, reset to the bottom of the range.` };
  }
  return { loadDeltaAbs: 0, repTargetDelta: 1, e1rmDelta: 0, repsReset: false, note: `Add a rep per set next session, working toward the cap (${cap}).` };
};

const linear: ProgressionRule["next"] = (input) => {
  const { exercise, plan, result } = input;
  const hit = result.sets.length >= plan.sets && result.sets.every((s) => s.reps >= plan.reps);
  const s = step(exercise);
  if (hit) return { loadDeltaAbs: s, repTargetDelta: 0, e1rmDelta: 0, repsReset: false, note: `All sets made → +${s} next session.` };
  return { ...NO_CHANGE, note: `Missed a set → repeat the load (reset on a second miss).` };
};

const amrapTopSet: ProgressionRule["next"] = (input) => {
  const { exercise, result } = input;
  const t = topSet(result);
  if (!t) return NO_CHANGE;
  const newE1rm = estimate1RM(t.weight, t.reps, t.rpe || 10);
  const e1rmDelta = newE1rm - (exercise.e1rm ?? newE1rm);
  return { loadDeltaAbs: 0, repTargetDelta: 0, e1rmDelta, repsReset: false, note: `Top set ${t.weight}×${t.reps} → e1RM ${Math.round(newE1rm)}; next loads re-derive from it.` };
};

const fiveThreeOne: ProgressionRule["next"] = (input) => {
  const { exercise, plan, result } = input;
  // TM bump driven by the AMRAP "+" set; standard +10 lower / +5 upper per cycle.
  const lower = exercise.compound && isLowerBody(exercise);
  const tmBump = lower ? 10 : 5;
  const last = result.sets[result.sets.length - 1];
  const target = exercise.repTarget ?? plan.reps;
  if (last && last.reps >= target + 3) {
    return { loadDeltaAbs: 0, repTargetDelta: 0, e1rmDelta: tmBump * 1.5, repsReset: false, note: `Strong AMRAP (${last.reps} reps) → raise Training Max by ${Math.round(tmBump * 1.5)} for the next cycle.` };
  }
  return { loadDeltaAbs: 0, repTargetDelta: 0, e1rmDelta: tmBump, repsReset: false, note: `End of cycle → Training Max +${tmBump} (${lower ? "lower" : "upper"} body).` };
};

const topSetBackoff: ProgressionRule["next"] = (input) => {
  const { exercise, plan, result } = input;
  const t = topSet(result); // the heavy top set (by e1RM — robust to logging order)
  if (!t) return NO_CHANGE;
  const cutoff = exercise.rirCap ?? plan.rir;
  const rir = rirFromRpe(t.rpe);
  const s = step(exercise);
  if (rir >= cutoff + 1) return { loadDeltaAbs: s * 2, repTargetDelta: 0, e1rmDelta: 0, repsReset: false, note: `Top set flew up (${rir} RIR) → +${s * 2} on the top set; back-offs follow.` };
  if (rir >= cutoff - 0.5) return { loadDeltaAbs: s, repTargetDelta: 0, e1rmDelta: 0, repsReset: false, note: `Top set on target → +${s}.` };
  return { ...NO_CHANGE, note: `Top set was a grind → hold and consolidate.` };
};

const compoundHypertrophy: ProgressionRule["next"] = (input) => {
  const { exercise, plan, result } = input;
  const cap = exercise.repCap ?? plan.reps + 4;
  const s = step(exercise);
  const SET_CAP = 6; // add sets up to this ceiling before reaching for more load
  const allHitCap = result.sets.length >= plan.sets && result.sets.every((x) => x.reps >= cap);
  if (allHitCap) {
    // Add a set first (volume); only add load once the set ceiling is reached.
    if (plan.sets < SET_CAP) {
      return { loadDeltaAbs: 0, repTargetDelta: 0, e1rmDelta: 0, repsReset: true, note: `Hit the rep cap on all sets → add a set next week (volume first), reset reps.` };
    }
    return { loadDeltaAbs: s, repTargetDelta: 0, e1rmDelta: 0, repsReset: true, note: `Volume maxed at the cap → +${s} and reset reps.` };
  }
  return { loadDeltaAbs: 0, repTargetDelta: 1, e1rmDelta: 0, repsReset: false, note: `Add a rep per set toward the cap (${cap}).` };
};

const dropSet: ProgressionRule["next"] = (input) => {
  const { exercise, plan, result } = input;
  const top = result.sets[0];
  if (!top) return NO_CHANGE;
  const target = exercise.repTarget ?? plan.reps;
  const s = step(exercise);
  if (top.reps >= target) return { loadDeltaAbs: s, repTargetDelta: 0, e1rmDelta: 0, repsReset: false, note: `Top set hit ${top.reps} (≥ ${target}) cleanly → +${s} on the top set.` };
  return { ...NO_CHANGE, note: `Top set under target → hold; the drops still bank volume.` };
};

/**
 * Calibration: estimate e1RM from a submaximal, RPE-rated top set — no failure,
 * no true-max test. The point of a return-from-layoff or new-lift block: dial in the
 * number from how the reps actually felt while connective tissue re-acclimates.
 */
const calibration: ProgressionRule["next"] = (input) => {
  const { exercise, result } = input;
  if (!result.sets.length) return NO_CHANGE;
  // The most informative set = the one implying the highest 1RM (uses the logged RPE).
  const best = result.sets.reduce((b, s) =>
    estimate1RM(s.weight, s.reps, s.rpe || 8) > estimate1RM(b.weight, b.reps, b.rpe || 8) ? s : b,
  );
  const newE1rm = estimate1RM(best.weight, best.reps, best.rpe || 8);
  const e1rmDelta = newE1rm - (exercise.e1rm ?? newE1rm);
  return {
    loadDeltaAbs: 0,
    repTargetDelta: 0,
    e1rmDelta,
    repsReset: false,
    note: `Calibration: ${best.weight}×${best.reps} @ RPE ${best.rpe ?? "?"} ⇒ estimated 1RM ${Math.round(newE1rm)}. Loads recalibrate off this — no max-out needed.`,
  };
};

function isLowerBody(exercise: Exercise): boolean {
  return ["Quadriceps", "Hamstrings", "Glutes", "Calves"].includes(exercise.muscle);
}

const IMPLS: Record<ProgressionRuleId, ProgressionRule["next"]> = {
  "set-threshold-rir": setThresholdRir,
  "last-set-rir": lastSetRir,
  "reps-to-failure": repsToFailure,
  "double-progression": doubleProgression,
  linear,
  "amrap-top-set": amrapTopSet,
  "five-three-one": fiveThreeOne,
  "top-set-backoff": topSetBackoff,
  "compound-hypertrophy": compoundHypertrophy,
  "drop-set": dropSet,
  calibration,
};

export const RULES: Record<ProgressionRuleId, ProgressionRule> = Object.fromEntries(
  (Object.keys(IMPLS) as ProgressionRuleId[]).map((id) => [
    id,
    { meta: RULE_META[id], next: IMPLS[id] },
  ]),
) as Record<ProgressionRuleId, ProgressionRule>;

export function getRule(id: ProgressionRuleId): ProgressionRule {
  return RULES[id];
}

/** Apply an exercise's rule to a session result. */
export function progress(
  exercise: Exercise,
  plan: WeekPlan,
  result: SessionResult,
): ProgressionDecision {
  return getRule(exercise.rule).next({ exercise, plan, result });
}

export { RULE_META };
export type { RuleMeta };
