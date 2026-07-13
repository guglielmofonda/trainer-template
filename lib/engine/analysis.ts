import type { MuscleGroup, Program, WeekPlan } from "./types";
import { buildCalendar } from "./calendar";
import { generateWeekPlans } from "./periodization";
import { VOLUME_LANDMARKS } from "../domain/muscles";

/* ----------------------------------------------------------------------------
 * Planning check & volume analysis.
 *
 * Reproduces the source's "Planning check" panel: weekly working sets per muscle,
 * total sets/reps, the composition (share of sets by muscle), and a verdict that
 * flags muscles below MEV (under-dosed) or above MRV (likely to outrun recovery).
 * ------------------------------------------------------------------------- */

export type VolumeVerdict = "under" | "maintenance" | "productive" | "high" | "over";

export interface MuscleVolume {
  muscle: MuscleGroup;
  sets: number;
  reps: number;
  /** Share of total weekly sets, 0..1. */
  share: number;
  verdict: VolumeVerdict;
  landmark: { mev: number; mavLow: number; mavHigh: number; mrv: number };
}

export interface PlanningCheck {
  week: number;
  totalSets: number;
  totalReps: number;
  byMuscle: MuscleVolume[];
  warnings: string[];
}

export function verdictFor(sets: number, muscle: MuscleGroup): VolumeVerdict {
  const l = VOLUME_LANDMARKS[muscle];
  if (sets < l.mev) return sets < l.mv ? "under" : "maintenance";
  if (sets > l.mrv) return "over";
  if (sets > l.mavHigh) return "high";
  return "productive";
}

/**
 * Compute the planning check for a given (1-based) week of the program.
 * Sets are counted per *primary* muscle (the source notes muscle groups are
 * assigned manually in v1, so we attribute the whole set to the primary muscle).
 */
export function planningCheck(program: Program, week = 1): PlanningCheck {
  const calendar = buildCalendar(program.cycle);
  const target = calendar.find((w) => w.week === week) ?? calendar[0];

  const setsByMuscle = new Map<MuscleGroup, number>();
  const repsByMuscle = new Map<MuscleGroup, number>();

  for (const day of program.days) {
    for (const ex of day.exercises) {
      const plans = generateWeekPlans(ex.wave, calendar);
      const plan = plans.find((p) => p.week === target.week) as WeekPlan | undefined;
      if (!plan) continue;
      setsByMuscle.set(ex.muscle, (setsByMuscle.get(ex.muscle) ?? 0) + plan.sets);
      repsByMuscle.set(ex.muscle, (repsByMuscle.get(ex.muscle) ?? 0) + plan.sets * plan.reps);
    }
  }

  const totalSets = [...setsByMuscle.values()].reduce((a, b) => a + b, 0);
  const totalReps = [...repsByMuscle.values()].reduce((a, b) => a + b, 0);

  const byMuscle: MuscleVolume[] = [...setsByMuscle.entries()]
    .map(([muscle, sets]) => {
      const l = VOLUME_LANDMARKS[muscle];
      return {
        muscle,
        sets,
        reps: repsByMuscle.get(muscle) ?? 0,
        share: totalSets > 0 ? sets / totalSets : 0,
        verdict: verdictFor(sets, muscle),
        landmark: { mev: l.mev, mavLow: l.mavLow, mavHigh: l.mavHigh, mrv: l.mrv },
      };
    })
    .sort((a, b) => b.sets - a.sets);

  const warnings: string[] = [];
  for (const m of byMuscle) {
    if (m.verdict === "under")
      warnings.push(`${m.muscle}: ${m.sets} sets is below MEV (${m.landmark.mev}) — likely too little to grow.`);
    if (m.verdict === "over")
      warnings.push(`${m.muscle}: ${m.sets} sets is above MRV (${m.landmark.mrv}) — may outrun recovery.`);
  }
  if (target.isDeload) warnings.push("This is a deload week — low volume is intentional.");

  return { week: target.week, totalSets, totalReps, byMuscle, warnings };
}

/** Average weekly volume across the whole (non-deload) cycle, per muscle. */
export function averageWeeklyVolume(program: Program): MuscleVolume[] {
  const calendar = buildCalendar(program.cycle);
  const trainingWeeks = calendar.filter((w) => !w.isDeload);
  const acc = new Map<MuscleGroup, { sets: number; reps: number }>();
  for (const w of trainingWeeks) {
    const check = planningCheck(program, w.week);
    for (const m of check.byMuscle) {
      const cur = acc.get(m.muscle) ?? { sets: 0, reps: 0 };
      acc.set(m.muscle, { sets: cur.sets + m.sets, reps: cur.reps + m.reps });
    }
  }
  const n = trainingWeeks.length || 1;
  const total = [...acc.values()].reduce((a, b) => a + b.sets, 0) / n;
  return [...acc.entries()]
    .map(([muscle, v]) => {
      const sets = v.sets / n;
      const l = VOLUME_LANDMARKS[muscle];
      return {
        muscle,
        sets: Math.round(sets * 10) / 10,
        reps: Math.round(v.reps / n),
        share: total > 0 ? sets / total : 0,
        verdict: verdictFor(sets, muscle),
        landmark: { mev: l.mev, mavLow: l.mavLow, mavHigh: l.mavHigh, mrv: l.mrv },
      };
    })
    .sort((a, b) => b.sets - a.sets);
}
