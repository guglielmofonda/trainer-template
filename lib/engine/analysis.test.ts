import { describe, it, expect } from "vitest";
import { planningCheck, averageWeeklyVolume } from "./analysis";
import { SEED_PROGRAM } from "../domain/seed";

describe("planning check (weekly volume analysis)", () => {
  const check = planningCheck(SEED_PROGRAM, 1);

  it("counts working sets across all days and reports a total", () => {
    expect(check.totalSets).toBeGreaterThan(0);
    const summed = check.byMuscle.reduce((a, m) => a + m.sets, 0);
    expect(summed).toBe(check.totalSets);
  });

  it("composition shares sum to ~1", () => {
    const sum = check.byMuscle.reduce((a, m) => a + m.share, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("assigns a landmark verdict to each muscle", () => {
    for (const m of check.byMuscle) {
      expect(["under", "maintenance", "productive", "high", "over"]).toContain(m.verdict);
    }
  });

  it("a deload week is flagged and carries less volume than week 1", () => {
    const deload = planningCheck(SEED_PROGRAM, 7);
    expect(deload.warnings.some((w) => w.toLowerCase().includes("deload"))).toBe(true);
    expect(deload.totalSets).toBeLessThan(check.totalSets);
  });
});

describe("average weekly volume", () => {
  it("returns per-muscle averages sorted by volume", () => {
    const avg = averageWeeklyVolume(SEED_PROGRAM);
    expect(avg.length).toBeGreaterThan(0);
    for (let i = 1; i < avg.length; i++) {
      expect(avg[i - 1].sets).toBeGreaterThanOrEqual(avg[i].sets);
    }
  });
});
