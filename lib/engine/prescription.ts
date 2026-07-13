import type { Exercise, Prescription, WeekPlan, RoundingConfig } from "./types";
import { e1rmFromSingle, loadForTarget, rpeFromRir } from "./e1rm";
import { roundWeight, DEFAULT_ROUNDING_LB } from "./rounding";
import { buildWarmupSets } from "./warmup";

/* ----------------------------------------------------------------------------
 * Prescription: WeekPlan + Exercise (+ optional today's opening single) → load.
 *
 * Two anchoring strategies (see Exercise.loadBasis):
 *
 *  "max"  — autoregulated compounds. Each session you work up to an OPENING SINGLE
 *           at a target RPE; that calibrates today's e1RM. The work sets are then
 *           prescribed as the load that yields the week's reps at the week's RIR
 *           off today's e1RM. Feel strong today → single is heavier → work sets
 *           are heavier (and vice-versa). This is the within-session autoregulation
 *           Matt demonstrates ("hit 410, prescription goes up; hit 375, it goes down").
 *
 *  "work" — accessories. The load is the configured working weight times the week's
 *           planned-load multiplier (the macro ramp). Progressed between sessions by
 *           the exercise's progression Rule.
 * ------------------------------------------------------------------------- */

export interface PrescribeOptions {
  /** Today's opening single (overrides the stored e1RM for "max" lifts). */
  openingSingle?: { weight: number; rpe: number };
}

export function rounding(exercise: Exercise): RoundingConfig {
  return exercise.rounding ?? DEFAULT_ROUNDING_LB;
}

/** The e1RM the prescription will be based on, given today's optional single. */
export function basisE1rm(exercise: Exercise, opts: PrescribeOptions = {}): number {
  if (opts.openingSingle) return e1rmFromSingle(opts.openingSingle);
  return exercise.e1rm ?? 0;
}

export function prescribe(
  exercise: Exercise,
  plan: WeekPlan,
  opts: PrescribeOptions = {},
): Prescription {
  const round = rounding(exercise);
  // rirCap is a *conservative floor*: follow the wave's RIR, but never grind
  // closer to failure than the cap (so it can only make a set easier, never
  // harder — including on deloads, where plan.rir is intentionally high).
  const rirCutoff = exercise.rirCap != null ? Math.max(exercise.rirCap, plan.rir) : plan.rir;
  const notes: string[] = [];

  if (exercise.loadBasis === "work") {
    const base = exercise.workWeight ?? 0;
    const load = roundWeight(base * plan.intensity, round);
    if (plan.isDeload) notes.push("Deload week — keep it crisp, leave the gym fresh.");
    return {
      exerciseId: exercise.id,
      week: plan.week,
      load,
      reps: plan.reps,
      sets: plan.sets,
      rirCutoff,
      warmupSets: buildWarmupSets(exercise, load),
      notes,
    };
  }

  // loadBasis === "max"
  const e1rm = basisE1rm(exercise, opts);
  // The week's RIR target maps to a %1RM; that's the working load off today's e1RM.
  const raw = loadForTarget(e1rm, plan.reps, rirCutoff);
  const load = roundWeight(raw, round);

  const out: Prescription = {
    exerciseId: exercise.id,
    week: plan.week,
    load,
    reps: plan.reps,
    sets: plan.sets,
    rirCutoff,
    basisE1rm: Math.round(e1rm),
    warmupSets: [],
    notes,
  };

  if (exercise.usesOpeningSingle) {
    // Suggest the opening single: 1 rep at the exercise's target RPE off the e1RM.
    const singleRpe = exercise.openingSingleRpe;
    const singleWeight = roundWeight(loadForTarget(e1rm, 1, rpeToRir(singleRpe)), round);
    out.openingSingle = { weight: singleWeight, rpe: singleRpe };
    notes.push(
      `Work up to a single @RPE ${singleRpe} (~${singleWeight}). Log it and the work sets re-scale to how you feel today.`,
    );
  }
  out.warmupSets = buildWarmupSets(exercise, out.openingSingle?.weight ?? load);
  if (out.warmupSets.length) {
    notes.unshift("Warm-up sets are rehearsal only — keep every rep fast and well away from fatigue.");
  }
  if (plan.isDeload) notes.push("Deload week — light, fast, submaximal.");
  notes.push(`Stop each work set at ${rirCutoff} RIR (RPE ${rpeFromRir(rirCutoff)}).`);
  return out;
}

function rpeToRir(rpe: number): number {
  return Math.max(0, 10 - rpe);
}
