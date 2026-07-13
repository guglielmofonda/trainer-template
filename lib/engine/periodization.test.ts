import { describe, it, expect } from "vitest";
import { buildCalendar, trainingWeekCount } from "./calendar";
import { generateWeekPlans } from "./periodization";
import type { CycleConfig, WaveConfig } from "./types";
import { DEFAULT_ROUNDING_LB } from "./rounding";

const CYCLE: CycleConfig = {
  weeksOn: 6,
  weeksOff: 1,
  mesocycles: 3,
  unit: "lb",
  rounding: DEFAULT_ROUNDING_LB,
};

// The back-squat "descending-wave" from the source video (frames t_020, t_040).
const SQUAT_WAVE: WaveConfig = {
  goal: "strength",
  shape: "descending-wave",
  waveLength: 3,
  repsStart: 6,
  repsEnd: 1,
  setsStart: 4,
  setsEnd: 4,
  rirStart: 3,
  rirEnd: 1,
  intensityStart: 1.04,
  intensityEnd: 1.25,
};

describe("calendar", () => {
  it("expands 6-on/1-off × 3 into 21 weeks with deloads on 7/14/21", () => {
    const cal = buildCalendar(CYCLE);
    expect(cal).toHaveLength(21);
    expect(trainingWeekCount(CYCLE)).toBe(18);
    const deloads = cal.filter((w) => w.isDeload).map((w) => w.week);
    expect(deloads).toEqual([7, 14, 21]);
    expect(cal[3].label).toBe("M1 W4"); // "month one, week four"
  });
});

describe("periodization — ground truth A (frame t_040, weeks 1–3 fully visible)", () => {
  const plans = generateWeekPlans(SQUAT_WAVE, buildCalendar(CYCLE));

  it("week 1 = 6 reps × 4 sets @ 3 RIR, intensity 1.04", () => {
    expect(plans[0]).toMatchObject({ reps: 6, sets: 4, rir: 3, intensity: 1.04 });
  });
  it("week 2 = 5 reps × 4 sets @ 2.5 RIR, intensity 1.06", () => {
    expect(plans[1]).toMatchObject({ reps: 5, sets: 4, rir: 2.5, intensity: 1.06 });
  });
  it("week 3 = 4 reps × 4 sets @ 1.5 RIR, intensity 1.08", () => {
    expect(plans[2]).toMatchObject({ reps: 4, sets: 4, rir: 1.5, intensity: 1.08 });
  });
  it("week 4 (next micro-wave) resets reps up to 5", () => {
    // GT A wk4 reps = 5. RIR resets toward the top of the new micro-wave (sawtooth),
    // matching the source's per-wave RIR reset (GT B) rather than a monotone descent.
    expect(plans[3].reps).toBe(5);
  });
  it("week 5 = 4 reps", () => {
    expect(plans[4].reps).toBe(4);
  });
});

describe("periodization — RIR sawtooth does NOT collapse in late waves", () => {
  const training = generateWeekPlans(SQUAT_WAVE, buildCalendar(CYCLE)).filter((p) => !p.isDeload);
  it("a late micro-wave still varies its RIR (resets up, then descends)", () => {
    // The 5th micro-wave (training weeks 13–15, 0-based 12–14): RIR must not be flat.
    const wave = training.slice(12, 15).map((p) => p.rir);
    const distinct = new Set(wave);
    expect(distinct.size).toBeGreaterThan(1); // was a flat [1,1,1] before the fix
    expect(Math.max(...wave)).toBeGreaterThan(SQUAT_WAVE.rirEnd); // resets above the floor
  });
});

describe("periodization — macro shape (easy → hard)", () => {
  const cal = buildCalendar(CYCLE);
  const plans = generateWeekPlans(SQUAT_WAVE, cal);
  const training = plans.filter((p) => !p.isDeload);

  it("final training week is a heavy single at intensityEnd", () => {
    const last = training[training.length - 1];
    expect(last.reps).toBe(1); // "very heavy singles in the last week"
    expect(last.intensity).toBe(1.25);
    expect(last.rir).toBe(1);
  });

  it("reps never drop below repsEnd and never exceed repsStart", () => {
    for (const p of training) {
      expect(p.reps).toBeGreaterThanOrEqual(SQUAT_WAVE.repsEnd);
      expect(p.reps).toBeLessThanOrEqual(SQUAT_WAVE.repsStart);
    }
  });

  it("RIR stays within [rirEnd, rirStart]", () => {
    for (const p of training) {
      expect(p.rir).toBeGreaterThanOrEqual(SQUAT_WAVE.rirEnd);
      expect(p.rir).toBeLessThanOrEqual(SQUAT_WAVE.rirStart);
    }
  });

  it("intensity is non-decreasing at the start of each micro-wave", () => {
    // Compare week 1 of each wave (indices 0,3,6,...) — the baseline must climb.
    const waveStarts = training.filter((_, i) => i % SQUAT_WAVE.waveLength === 0);
    for (let i = 1; i < waveStarts.length; i++) {
      expect(waveStarts[i].intensity).toBeGreaterThanOrEqual(waveStarts[i - 1].intensity);
    }
  });
});

describe("periodization — deloads", () => {
  const plans = generateWeekPlans(SQUAT_WAVE, buildCalendar(CYCLE));
  it("deload weeks cut sets and back off load & RIR", () => {
    const deload = plans[6]; // week 7
    expect(deload.isDeload).toBe(true);
    expect(deload.sets).toBeLessThan(SQUAT_WAVE.setsStart);
    expect(deload.rir).toBeGreaterThan(SQUAT_WAVE.rirStart);
    expect(deload.intensity).toBeLessThan(SQUAT_WAVE.intensityStart);
  });
});
