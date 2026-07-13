import { describe, it, expect } from "vitest";
import { applySession, prescribe, buildCalendar, generateWeekPlans } from "./index";
import { SEED_PROGRAM } from "../domain/seed";
import type { Exercise } from "./types";

/**
 * Regression tests for defects found by the adversarial engine review.
 */
describe("review regressions", () => {
  const program = SEED_PROGRAM;
  const squat = program.days[0].exercises[0]; // Back Squat — set-threshold, max basis

  it("deload weeks apply no progression (recovery only)", () => {
    const { decision } = applySession(program, squat, 7 /* deload */, {
      exerciseId: squat.id,
      week: 7,
      openingSingle: { weight: 415, rpe: 8 },
      sets: Array(4).fill({ weight: 320, reps: 5, rpe: 7.5 }),
      setsCompleted: 4,
    });
    expect(decision.loadDeltaAbs).toBe(0);
    expect(decision.repsReset).toBe(false);
    expect(decision.note.toLowerCase()).toContain("deload");
  });

  it("max-basis reps-to-failure does not double-count the load change", () => {
    const ex: Exercise = { ...squat, id: "rtf", rule: "reps-to-failure", repTarget: 6 };
    const nextPlan = generateWeekPlans(ex.wave, buildCalendar(program.cycle)).find((p) => p.week === 5)!;
    const single = { weight: 415, rpe: 8 };
    const { decision, nextPreview } = applySession(program, ex, 4, {
      exerciseId: ex.id,
      week: 4,
      openingSingle: single,
      sets: [{ weight: 365, reps: 8, rpe: 10 }], // beat target by 2
    });
    // This rule emits BOTH an e1rm change and an absolute load step.
    expect(decision.e1rmDelta).toBeGreaterThan(0);
    expect(decision.loadDeltaAbs).toBeGreaterThan(0);
    // The preview must come from the e1rm channel only — not e1rm + an extra step.
    const expected = prescribe(ex, nextPlan, { openingSingle: single }).load;
    expect(nextPreview.load).toBe(expected);
  });

  it("rirCap is a floor — it never makes a deload heavier than the wave intends", () => {
    const ex: Exercise = { ...squat, id: "capped", rirCap: 2.5 };
    const deload = generateWeekPlans(ex.wave, buildCalendar(program.cycle)).find((p) => p.isDeload)!;
    const capped = prescribe(ex, deload);
    const uncapped = prescribe({ ...ex, rirCap: undefined }, deload);
    // The high deload RIR wins over the lower cap (cap can only ease, never grind).
    expect(capped.rirCutoff).toBe(deload.rir);
    expect(capped.load).toBeLessThanOrEqual(uncapped.load);
  });

  it("double-progression preview rep target agrees with the 'add a rep' note", () => {
    const acc = program.days[0].exercises[2]; // Leg Extensions — double progression, work basis
    const nextPlan = generateWeekPlans(acc.wave, buildCalendar(program.cycle)).find((p) => p.week === 2)!;
    const { decision, nextPreview } = applySession(program, acc, 1, {
      exerciseId: acc.id,
      week: 1,
      sets: Array(acc.wave.setsStart).fill({ weight: 120, reps: 13, rpe: 8 }), // under cap
    });
    expect(decision.repTargetDelta).toBe(1);
    // Preview should show one more rep than the plan, not the bare plan reps.
    expect(nextPreview.reps).toBe(nextPlan.reps + 1);
  });
});
