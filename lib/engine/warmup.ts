import type { Exercise, WarmupSet } from "./types";
import { DEFAULT_ROUNDING_LB, roundWeight } from "./rounding";

/**
 * Build a low-fatigue, movement-specific ramp toward the heaviest thing that
 * comes next (the opening single when present, otherwise the work-set load).
 *
 * The shape deliberately mirrors the reference athlete's ramp: start with the empty
 * bar (95 lb for deadlift), make one useful middle jump, then take a short
 * primer near 80% of the target. Reps fall as load rises so the warm-up does
 * not steal performance from the work sets.
 */
export function buildWarmupSets(exercise: Exercise, targetLoad: number): WarmupSet[] {
  const config = exercise.warmup;
  if (!config || targetLoad <= 0) return [];

  const deadlift = config.profile === "deadlift";
  const candidates: WarmupSet[] = [
    { load: config.startLoad, reps: 8 },
    { load: targetLoad * 0.6, reps: deadlift ? 3 : 5 },
    { load: targetLoad * 0.8, reps: deadlift ? 2 : 3 },
  ];

  const out: WarmupSet[] = [];
  for (const candidate of candidates) {
    const load = roundWeight(candidate.load, exercise.rounding ?? DEFAULT_ROUNDING_LB);
    const previous = out.at(-1)?.load ?? 0;
    // Warm-ups must climb, remain strictly below the target, and never repeat
    // a load after plate rounding (important on lighter overhead-press days).
    if (load <= previous || load >= targetLoad) continue;
    out.push({ load, reps: candidate.reps });
  }
  return out;
}
