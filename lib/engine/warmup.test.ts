import { describe, expect, it } from "vitest";
import type { Exercise } from "./types";
import { buildWarmupSets } from "./warmup";

function exercise(over: Partial<Exercise> = {}): Exercise {
  return {
    id: "squat",
    name: "Back Squat",
    muscle: "Quadriceps",
    compound: true,
    usesOpeningSingle: false,
    openingSingleRpe: 8,
    warmup: { profile: "standard", startLoad: 45 },
    loadBasis: "max",
    e1rm: 200,
    rule: "calibration",
    wave: {
      goal: "strength",
      shape: "flat",
      waveLength: 1,
      repsStart: 5,
      repsEnd: 5,
      setsStart: 3,
      setsEnd: 3,
      rirStart: 2,
      rirEnd: 2,
      intensityStart: 1,
      intensityEnd: 1,
    },
    rounding: { increment: 5, mode: "nearest" },
    ...over,
  };
}

describe("compound warm-up prescription", () => {
  it("mirrors the reference bar-first ramp while reducing reps as load rises", () => {
    expect(buildWarmupSets(exercise(), 155)).toEqual([
      { load: 45, reps: 8 },
      { load: 95, reps: 5 },
      { load: 125, reps: 3 },
    ]);
  });

  it("uses fewer reps for deadlift ramps", () => {
    expect(
      buildWarmupSets(
        exercise({ name: "Deadlift", warmup: { profile: "deadlift", startLoad: 75 } }),
        215,
      ),
    ).toEqual([
      { load: 75, reps: 8 },
      { load: 130, reps: 3 },
      { load: 170, reps: 2 },
    ]);
  });

  it("deduplicates rounded steps and never reaches the working load", () => {
    expect(buildWarmupSets(exercise(), 60)).toEqual([
      { load: 45, reps: 8 },
      { load: 50, reps: 3 },
    ]);
  });

  it("does not invent warm-ups for exercises without a warm-up policy", () => {
    expect(buildWarmupSets(exercise({ warmup: undefined }), 155)).toEqual([]);
  });
});
