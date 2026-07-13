/**
 * RPE / RIR ⇄ %1RM mathematics — the basis of autoregulation.
 *
 * The model rests on one robust empirical observation (Tuchscherer's RPE chart,
 * validated by Helms et al. 2018 and widely used in evidence-based programming):
 *
 *   The fraction of 1RM you can lift depends almost entirely on the number of reps
 *   you have *left in the tank*. A set is fully described by its "n-rep-max
 *   equivalent" = reps performed + reps in reserve.
 *
 *   Example: 5 reps stopped at 2 RIR (RPE 8) sits at the same %1RM as a true 7-rep
 *   max — because in both cases the bar is at the weight you could do 7 times.
 *
 * So a 2-D table (reps × RPE) collapses to a 1-D curve indexed by
 *   effectiveReps = reps + RIR = reps + (10 - RPE).
 *
 * `RPE10_PERCENT[n]` is the % of 1RM for an n-rep max (RPE-10 set of n reps).
 * Values are the standard chart (Helms/Tuchscherer), rounded to 3 dp.
 */

/** %1RM for an n-rep max. Index 0 is unused; 1 → 100%. */
export const RPE10_PERCENT: readonly number[] = [
  0, // 0 (unused)
  1.0, // 1RM
  0.955, // 2
  0.922, // 3
  0.892, // 4
  0.863, // 5
  0.837, // 6
  0.811, // 7
  0.786, // 8
  0.762, // 9
  0.739, // 10
  0.717, // 11
  0.696, // 12
  0.675, // 13
  0.655, // 14
  0.636, // 15
];

/** Linear-interpolated %1RM for a (possibly fractional) n-rep max. */
export function percentForRepMax(effectiveReps: number): number {
  if (effectiveReps <= 1) return 1;
  const maxIndex = RPE10_PERCENT.length - 1;
  if (effectiveReps >= maxIndex) {
    // Extrapolate gently beyond the table (~ -2%/rep) so very high-rep sets still resolve.
    const tail = RPE10_PERCENT[maxIndex];
    return Math.max(0.3, tail - (effectiveReps - maxIndex) * 0.02);
  }
  const lo = Math.floor(effectiveReps);
  const hi = lo + 1;
  const frac = effectiveReps - lo;
  return RPE10_PERCENT[lo] + (RPE10_PERCENT[hi] - RPE10_PERCENT[lo]) * frac;
}

export function rirFromRpe(rpe: number): number {
  return clampRir(10 - rpe);
}

export function rpeFromRir(rir: number): number {
  return 10 - rir;
}

function clampRir(rir: number): number {
  return Math.max(0, rir);
}

/**
 * %1RM required to perform `reps` reps stopping at `rir` reps in reserve.
 * This is the load target the prescription engine aims for.
 */
export function percentOf1RM(reps: number, rir: number): number {
  return percentForRepMax(reps + clampRir(rir));
}

/**
 * Estimate 1RM from any work-set data point (weight × reps @ RPE).
 *   e1RM = weight / %1RM(reps, RIR)
 */
export function estimate1RM(weight: number, reps: number, rpe: number): number {
  const pct = percentOf1RM(reps, rirFromRpe(rpe));
  return weight / pct;
}

/**
 * Estimate 1RM from an "opening single" worked up to a target RPE.
 * A single @ RPE 8 sits at the 3-rep-max %1RM (1 rep + 2 RIR) ≈ 92.2%.
 */
export function e1rmFromSingle(single: { weight: number; rpe: number }): number {
  return estimate1RM(single.weight, 1, single.rpe);
}

/**
 * Inverse: the load that yields `reps` reps at `rir` RIR off a known 1RM.
 */
export function loadForTarget(e1rm: number, reps: number, rir: number): number {
  return e1rm * percentOf1RM(reps, rir);
}

/**
 * Epley estimate from a rep-out to true failure (RPE 10). Used as a cross-check
 * and for "reps to failure" rules where RPE wasn't recorded.
 */
export function epley1RM(weight: number, reps: number): number {
  return weight * (1 + reps / 30);
}
