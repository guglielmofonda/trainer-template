import { describe, it, expect } from "vitest";
import {
  estimate1RM,
  e1rmFromSingle,
  percentOf1RM,
  loadForTarget,
} from "./e1rm";
import { prescribe } from "./prescription";
import { progress } from "./rules";
import type { Exercise, WeekPlan, SessionResult } from "./types";
import { DEFAULT_ROUNDING_LB } from "./rounding";

const squat: Exercise = {
  id: "back-squat",
  name: "Back Squat",
  muscle: "Quadriceps",
  compound: true,
  usesOpeningSingle: true,
  openingSingleRpe: 8,
  loadBasis: "max",
  e1rm: 410,
  rule: "set-threshold-rir",
  rounding: DEFAULT_ROUNDING_LB,
  wave: {
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
  },
};

describe("RPE / e1RM math", () => {
  it("collapses (reps × RPE) to the n-rep-max curve: 5@8 == 7RM", () => {
    // 5 reps at RPE 8 (2 RIR) sits at the 7-rep-max %1RM.
    expect(percentOf1RM(5, 2)).toBeCloseTo(0.811, 3); // 7RM = 81.1%
  });

  it("a single @ RPE 8 (≈92.2% 1RM) estimates e1RM in the right ballpark", () => {
    // Video: opening single 375 @8 → e1RM ≈ 407–417, single target ≈ 410.
    const e = e1rmFromSingle({ weight: 375, rpe: 8 });
    expect(e).toBeGreaterThan(400);
    expect(e).toBeLessThan(415);
  });

  it("estimate1RM is consistent with loadForTarget (round-trip)", () => {
    const e = 410;
    const load = loadForTarget(e, 5, 2); // 5 reps @ 2 RIR
    expect(estimate1RM(load, 5, 8)).toBeCloseTo(e, 1);
  });
});

describe("within-session autoregulation (opening single drives the prescription)", () => {
  const plan: WeekPlan = { week: 4, isDeload: false, reps: 5, sets: 4, rir: 2.5, intensity: 1.06 };

  it("a heavier opening single raises the prescribed work load", () => {
    const light = prescribe(squat, plan, { openingSingle: { weight: 375, rpe: 8 } });
    const heavy = prescribe(squat, plan, { openingSingle: { weight: 415, rpe: 8 } });
    expect(heavy.load).toBeGreaterThan(light.load); // "hit 415 → prescription goes up"
  });

  it("a lighter opening single lowers the prescribed work load", () => {
    const base = prescribe(squat, plan, { openingSingle: { weight: 410, rpe: 8 } });
    const lighter = prescribe(squat, plan, { openingSingle: { weight: 375, rpe: 8 } });
    expect(lighter.load).toBeLessThan(base.load); // "hit 375 → it goes down"
  });

  it("work load rounds to the loadable increment (5 lb)", () => {
    const p = prescribe(squat, plan, { openingSingle: { weight: 410, rpe: 8 } });
    expect(p.load % 5).toBe(0);
  });
});

describe("between-session autoregulation (set-threshold RIR)", () => {
  const plan: WeekPlan = { week: 4, isDeload: false, reps: 5, sets: 4, rir: 2.5, intensity: 1.06 };

  it("completing the set cap bumps load and resets reps (+10 for a compound)", () => {
    const result: SessionResult = {
      exerciseId: squat.id,
      week: 4,
      setsCompleted: 4,
      sets: [
        { weight: 320, reps: 5, rpe: 7.5 },
        { weight: 320, reps: 5, rpe: 7.5 },
        { weight: 320, reps: 5, rpe: 7.5 },
        { weight: 320, reps: 5, rpe: 7.5 },
      ],
    };
    const d = progress(squat, plan, result);
    expect(d.loadDeltaAbs).toBe(10); // compound step = 2 × 5 lb
    expect(d.repsReset).toBe(true);
  });

  it("falling short of the set cap holds the load", () => {
    const result: SessionResult = {
      exerciseId: squat.id,
      week: 4,
      setsCompleted: 2,
      sets: [
        { weight: 320, reps: 5, rpe: 7.5 },
        { weight: 320, reps: 5, rpe: 7.5 },
      ],
    };
    const d = progress(squat, plan, result);
    expect(d.loadDeltaAbs).toBe(0);
    expect(d.repsReset).toBe(false);
  });
});

describe("double progression", () => {
  const accessory: Exercise = {
    ...squat,
    id: "leg-ext",
    name: "Leg Extension",
    compound: false,
    usesOpeningSingle: false,
    loadBasis: "work",
    workWeight: 120,
    rule: "double-progression",
    repCap: 16,
    e1rm: undefined,
  };
  const plan: WeekPlan = { week: 1, isDeload: false, reps: 12, sets: 4, rir: 2, intensity: 1.0 };

  it("adds a rep until the cap, then adds load and resets", () => {
    const underCap: SessionResult = {
      exerciseId: accessory.id,
      week: 1,
      sets: Array(4).fill({ weight: 120, reps: 13, rpe: 8 }),
    };
    expect(progress(accessory, plan, underCap).repTargetDelta).toBe(1);

    const atCap: SessionResult = {
      exerciseId: accessory.id,
      week: 1,
      sets: Array(4).fill({ weight: 120, reps: 16, rpe: 9 }),
    };
    const d = progress(accessory, plan, atCap);
    expect(d.loadDeltaAbs).toBe(5); // accessory step
    expect(d.repsReset).toBe(true);
  });
});

describe("calibration (RPE-based e1RM estimation, no max-out)", () => {
  const calLift: Exercise = {
    ...squat,
    id: "cal-squat",
    rule: "calibration",
    usesOpeningSingle: false,
    e1rm: 85,
  };
  const plan: WeekPlan = { week: 2, isDeload: false, reps: 5, sets: 3, rir: 2, intensity: 1.0 };

  it("estimates an e1RM from a submaximal RPE-rated set, near the truth", () => {
    const d = progress(calLift, plan, {
      exerciseId: calLift.id,
      week: 2,
      sets: [{ weight: 67.5, reps: 5, rpe: 7 }], // a true-ish 7RM ≈ mid-80s
    });
    const newE1rm = 85 + d.e1rmDelta;
    expect(newE1rm).toBeGreaterThan(80);
    expect(newE1rm).toBeLessThan(92);
  });

  it("an easier-than-expected set raises the estimate; a harder one lowers it", () => {
    const easy = progress(calLift, plan, { exerciseId: calLift.id, week: 2, sets: [{ weight: 67.5, reps: 5, rpe: 6 }] });
    const hard = progress(calLift, plan, { exerciseId: calLift.id, week: 2, sets: [{ weight: 67.5, reps: 5, rpe: 8 }] });
    expect(easy.e1rmDelta).toBeGreaterThan(hard.e1rmDelta);
    expect(easy.e1rmDelta).toBeGreaterThan(0); // RPE 6 on a 5-rep set implies > 85
  });

  it("uses the most informative set (the one implying the highest 1RM)", () => {
    const d = progress(calLift, plan, {
      exerciseId: calLift.id,
      week: 2,
      sets: [
        { weight: 60, reps: 5, rpe: 6 },
        { weight: 70, reps: 5, rpe: 8 }, // heavier & harder → implies the higher max
      ],
    });
    expect(Math.round(85 + d.e1rmDelta)).toBe(Math.round(estimate1RM(70, 5, 8)));
  });

  it("only moves e1RM — it never directly changes reps or working load", () => {
    const d = progress(calLift, plan, { exerciseId: calLift.id, week: 2, sets: [{ weight: 67.5, reps: 5, rpe: 7 }] });
    expect(d.loadDeltaAbs).toBe(0);
    expect(d.repTargetDelta).toBe(0);
    expect(d.repsReset).toBe(false);
  });
});
