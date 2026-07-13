/**
 * Actual training volume by muscle — what the body really did in a week.
 *
 * PURE. The planning check (`engine/analysis`) reports the *planned* dose; this
 * is its actuals counterpart, built from workout impacts. Every working set
 * counts no matter which exercise delivered it: sets on matched planned lifts,
 * sets on same-muscle substitutes (swaps), and sets on unplanned extras — so
 * doing 4 sets where 3 were planned, or hammer curls instead of barbell curls,
 * still shows up as work done. Warm-ups never count.
 *
 * Attribution: planned/swapped rows credit the program slot's muscle (a swap is
 * same-muscle by definition); extras credit the Hevy template's mapped muscle.
 * Extras whose Hevy muscle doesn't map to an engine group are surfaced in
 * `unmappedSets` rather than silently dropped.
 */
import type { MuscleGroup, Program } from "../../engine/types";
import { planningCheck, verdictFor, type VolumeVerdict } from "../../engine/analysis";
import { VOLUME_LANDMARKS } from "../../domain/muscles";
import type { WorkoutActualSet, WorkoutImpact } from "./impact";

export interface MuscleActualVolume {
  muscle: MuscleGroup;
  /** Working sets actually performed: planned + swapped + extra. */
  sets: number;
  /** The program's planned working sets for this muscle in this week. */
  plannedSets: number;
  /** Working sets from matched planned lifts. */
  fromPlanned: number;
  /** Working sets from same-muscle substitutes claimed for a planned slot. */
  fromSwaps: number;
  /** Working sets from unplanned extras. */
  fromExtras: number;
  /** Landmark verdict on the ACTUAL dose (same scale as the planning check). */
  verdict: VolumeVerdict;
  landmark: { mev: number; mavLow: number; mavHigh: number; mrv: number };
}

export interface WeekActualVolume {
  week: number;
  /** All working sets attributed to a muscle this week. */
  totalSets: number;
  /** Sorted most-worked first; planned-but-untrained muscles appear with 0. */
  byMuscle: MuscleActualVolume[];
  /** Working sets on lifts whose Hevy muscle doesn't map to an engine group. */
  unmappedSets: number;
}

function workingSetCount(sets: WorkoutActualSet[]): number {
  return sets.filter((s) => s.type !== "warmup").length;
}

/**
 * Aggregate the actual per-muscle volume for one program week from workout
 * impacts. Impacts from other weeks are ignored, so the caller can pass the
 * whole recent window unfiltered.
 */
export function actualWeekVolume(
  program: Program,
  impacts: WorkoutImpact[],
  week: number,
): WeekActualVolume {
  const planned = new Map(planningCheck(program, week).byMuscle.map((m) => [m.muscle, m.sets]));
  const acc = new Map<MuscleGroup, { planned: number; swaps: number; extras: number }>();
  let unmappedSets = 0;

  const bump = (muscle: MuscleGroup, kind: "planned" | "swaps" | "extras", n: number) => {
    const cur = acc.get(muscle) ?? { planned: 0, swaps: 0, extras: 0 };
    cur[kind] += n;
    acc.set(muscle, cur);
  };

  for (const impact of impacts) {
    if (impact.week !== week) continue;
    for (const row of impact.exercises) {
      const n = workingSetCount(row.actualSets);
      if (n === 0) continue;
      bump(row.exercise.muscle, row.status === "swapped" ? "swaps" : "planned", n);
    }
    for (const extra of impact.extras) {
      const n = workingSetCount(extra.actualSets);
      if (n === 0) continue;
      if (extra.muscle) bump(extra.muscle, "extras", n);
      else unmappedSets += n;
    }
  }

  // Planned-but-untrained muscles stay visible at 0 so the gap is honest.
  for (const muscle of planned.keys()) {
    if (!acc.has(muscle)) acc.set(muscle, { planned: 0, swaps: 0, extras: 0 });
  }

  const byMuscle: MuscleActualVolume[] = [...acc.entries()]
    .map(([muscle, v]) => {
      const sets = v.planned + v.swaps + v.extras;
      const l = VOLUME_LANDMARKS[muscle];
      return {
        muscle,
        sets,
        plannedSets: planned.get(muscle) ?? 0,
        fromPlanned: v.planned,
        fromSwaps: v.swaps,
        fromExtras: v.extras,
        verdict: verdictFor(sets, muscle),
        landmark: { mev: l.mev, mavLow: l.mavLow, mavHigh: l.mavHigh, mrv: l.mrv },
      };
    })
    .sort((a, b) => b.sets - a.sets);

  return {
    week,
    totalSets: byMuscle.reduce((a, m) => a + m.sets, 0),
    byMuscle,
    unmappedSets,
  };
}
