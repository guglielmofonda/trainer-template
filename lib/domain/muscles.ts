import type { MuscleGroup } from "../engine/types";

/**
 * Weekly volume landmarks (hard sets / muscle / week), after Israetel / Renaissance
 * Periodization. These are population guidelines, not laws — the planning check uses
 * them to flag muscles that look under- or over-dosed for the week.
 *
 *  MV  = Maintenance Volume      (keep what you have)
 *  MEV = Minimum Effective Volume (smallest dose that grows)
 *  MAV = Maximum Adaptive Volume  (the productive working range)
 *  MRV = Maximum Recoverable Volume (ceiling before fatigue outruns recovery)
 */
export interface VolumeLandmarks {
  mv: number;
  mev: number;
  mavLow: number;
  mavHigh: number;
  mrv: number;
}

export const VOLUME_LANDMARKS: Record<MuscleGroup, VolumeLandmarks> = {
  Chest: { mv: 8, mev: 10, mavLow: 12, mavHigh: 20, mrv: 22 },
  Back: { mv: 8, mev: 10, mavLow: 14, mavHigh: 22, mrv: 25 },
  Quadriceps: { mv: 6, mev: 8, mavLow: 12, mavHigh: 18, mrv: 20 },
  Hamstrings: { mv: 4, mev: 6, mavLow: 10, mavHigh: 16, mrv: 20 },
  Glutes: { mv: 0, mev: 4, mavLow: 6, mavHigh: 12, mrv: 16 },
  Shoulders: { mv: 8, mev: 8, mavLow: 16, mavHigh: 22, mrv: 26 },
  Biceps: { mv: 6, mev: 8, mavLow: 14, mavHigh: 20, mrv: 26 },
  Triceps: { mv: 4, mev: 6, mavLow: 10, mavHigh: 14, mrv: 18 },
  Calves: { mv: 6, mev: 8, mavLow: 12, mavHigh: 16, mrv: 20 },
  Abs: { mv: 0, mev: 0, mavLow: 16, mavHigh: 25, mrv: 25 },
  Forearms: { mv: 0, mev: 2, mavLow: 6, mavHigh: 12, mrv: 16 },
};

export const ALL_MUSCLES: MuscleGroup[] = Object.keys(VOLUME_LANDMARKS) as MuscleGroup[];
