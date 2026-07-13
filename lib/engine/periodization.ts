import type { CalendarWeek, WaveConfig, WeekPlan } from "./types";

/* ----------------------------------------------------------------------------
 * Periodization: turn one exercise's WaveConfig into a week-by-week WeekPlan[].
 *
 * The default shape is WAVE PERIODIZATION (a sawtooth):
 *   - Reps fall and load climbs across each short "micro-wave" (default 3 weeks).
 *   - Each new micro-wave resets reps slightly and bumps the baseline load.
 *   - Across the whole cycle the program ramps EASY → HARD: high-rep / high-RIR /
 *     low-intensity at the start, descending to heavy SINGLES at the configured
 *     `intensityEnd` in the final training week.
 *   - Deload weeks cut volume and load for recovery.
 *
 * Calibration: the constants below reproduce the back-squat "descending-wave"
 * table shown in the source video EXACTLY for the first micro-wave
 * (reps 6/5/4, RIR 3/2.5/1.5, intensity 1.04/1.06/1.08) and land the final
 * training week on a single at `intensityEnd`. See lib/engine/periodization.test.ts.
 * ------------------------------------------------------------------------- */

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const round1 = (x: number) => Math.round(x * 10) / 10;
const roundHalf = (x: number) => Math.round(x * 2) / 2; // nearest 0.5
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Default within-micro-wave load step (matches the source's +0.02/week climb). */
const DEFAULT_INTENSITY_STEP = 0.02;
/** Fraction of the RIR range that is spent *within* a single micro-wave. */
const WITHIN_WAVE_RIR_DROP_FRAC = 0.75;

export interface WaveContext {
  /** Total number of *training* (non-deload) weeks in the cycle. */
  trainingWeeks: number;
}

/**
 * Generate the plan for every calendar week (training + deload).
 */
export function generateWeekPlans(
  wave: WaveConfig,
  calendar: CalendarWeek[],
): WeekPlan[] {
  const trainingWeeks = calendar.filter((w) => !w.isDeload).length;
  const plans: WeekPlan[] = [];
  let trainingIndex = 0;
  for (const cw of calendar) {
    if (cw.isDeload) {
      plans.push(deloadPlan(wave, cw.week));
    } else {
      plans.push(trainingPlan(wave, cw.week, trainingIndex, { trainingWeeks }));
      trainingIndex++;
    }
  }
  return plans;
}

/** The prescription for a single training week (0-based `t` among training weeks). */
export function trainingPlan(
  wave: WaveConfig,
  week: number,
  t: number,
  ctx: WaveContext,
): WeekPlan {
  const L = Math.max(1, wave.waveLength);
  const nWaves = Math.max(1, Math.ceil(ctx.trainingWeeks / L));
  const w = Math.floor(t / L); // which micro-wave
  const p = t % L; // position within the micro-wave
  const fracWave = nWaves > 1 ? w / (nWaves - 1) : 0;
  const posFrac = L > 1 ? p / (L - 1) : 0;

  // --- Reps: wave top descends across waves; -1 per week within a wave. ---
  // Final wave's top = repsEnd + (L-1) so the last week lands exactly on repsEnd.
  const waveTopReps = Math.round(lerp(wave.repsStart, wave.repsEnd + (L - 1), fracWave));
  const reps = Math.max(wave.repsEnd, waveTopReps - p);

  // --- Sets: interpolate across the cycle (usually constant). ---
  const sets = Math.max(1, Math.round(lerp(wave.setsStart, wave.setsEnd, fracWave)));

  // --- RIR: a sawtooth that RESETS toward the top each micro-wave and descends
  // within it, with only a gentle macro drift so the final week lands on rirEnd.
  // This matches the source's late-week table (GROUND TRUTH B: RIR jumps back up
  // to ~2.5 at each new wave) instead of collapsing every late set to rirEnd.
  const rirRange = wave.rirStart - wave.rirEnd;
  const waveTopRir = lerp(wave.rirStart, wave.rirStart - rirRange / 2, fracWave);
  const waveBottomRir = lerp(wave.rirStart - rirRange * WITHIN_WAVE_RIR_DROP_FRAC, wave.rirEnd, fracWave);
  const rir = clamp(roundHalf(lerp(waveTopRir, waveBottomRir, posFrac)), wave.rirEnd, wave.rirStart);

  // --- Intensity (planned-load multiplier): climbs within wave + across waves. ---
  // Cap the per-week step so the wave-start ramp never inverts on small ranges.
  const step = Math.min(
    DEFAULT_INTENSITY_STEP,
    (wave.intensityEnd - wave.intensityStart) / Math.max(1, L - 1),
  );
  const waveStartInt = lerp(wave.intensityStart, wave.intensityEnd - (L - 1) * step, fracWave);
  const intensity = round3(waveStartInt + p * step);

  return { week, isDeload: false, reps, sets, rir, intensity };
}

/** Recovery week: half the volume, back to easy reps, well shy of failure, ~-10% load. */
export function deloadPlan(wave: WaveConfig, week: number): WeekPlan {
  return {
    week,
    isDeload: true,
    reps: wave.repsStart,
    sets: Math.max(1, Math.round(wave.setsStart * 0.5)),
    rir: wave.rirStart + 1,
    intensity: round3(wave.intensityStart * 0.9),
  };
}

/**
 * Convenience: the whole periodization table as rows, including deloads.
 * Useful for the configuration "periodization table" preview.
 */
export function periodizationTable(
  wave: WaveConfig,
  calendar: CalendarWeek[],
): Array<WeekPlan & { label: string }> {
  const plans = generateWeekPlans(wave, calendar);
  return plans.map((plan, i) => ({ ...plan, label: calendar[i].label }));
}

export { round1, roundHalf, round3 };
