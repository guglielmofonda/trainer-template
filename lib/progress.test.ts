import { describe, expect, it } from "vitest";
import { buildProgressSnapshot } from "./progress";
import type { HevyWorkout } from "./integrations/hevy";

function workout(
  id: string,
  date: string,
  title: string,
  sets: Array<{ type: string; weight_kg: number | null; reps: number | null; rpe: number | null }>,
): HevyWorkout {
  return {
    id,
    title: id,
    start_time: date,
    end_time: date,
    created_at: date,
    updated_at: date,
    exercises: [
      {
        index: 0,
        title,
        exercise_template_id: title,
        sets: sets.map((set, index) => ({
          index,
          ...set,
          distance_meters: null,
          duration_seconds: null,
          custom_metric: null,
        })),
      },
    ],
  };
}

describe("buildProgressSnapshot", () => {
  it("keeps the best working-set e1RM per lift and workout", () => {
    const result = buildProgressSnapshot({
      now: "2026-07-10T12:00:00Z",
      windowDays: 365,
      workouts: [
        workout("first", "2026-06-01T12:00:00Z", "Squat (Barbell)", [
          { type: "warmup", weight_kg: 40, reps: 8, rpe: null },
          { type: "normal", weight_kg: 80, reps: 5, rpe: 8 },
          { type: "normal", weight_kg: 85, reps: 3, rpe: 9 },
        ]),
        workout("second", "2026-07-01T12:00:00Z", "Squat (Barbell)", [
          { type: "normal", weight_kg: 90, reps: 5, rpe: 8 },
        ]),
      ],
      measurements: [],
    });

    const squat = result.lifts.find((lift) => lift.key === "squat")!;
    expect(squat.points).toHaveLength(2);
    // 80 kg × 5 @8 estimates higher than the heavier triple, so it is the
    // representative strength set for this workout.
    expect(squat.points[0].weightLb).toBe(176.5);
    expect(squat.points[0].estimateMethod).toBe("rpe");
    expect(squat.latest).toBeGreaterThan(squat.points[0].estimated1RmLb);
    expect(squat.changeLb).toBeGreaterThan(0);
  });

  it("converts, deduplicates, filters, and orders Hevy bodyweight entries", () => {
    const result = buildProgressSnapshot({
      now: "2026-07-10T12:00:00Z",
      windowDays: 60,
      workouts: [],
      measurements: [
        { date: "2026-07-01", weight_kg: 80 },
        { date: "2026-06-01", weight_kg: 79 },
        { date: "2026-07-01", weight_kg: 81 },
        { date: "2025-01-01", weight_kg: 70 },
        { date: "2026-07-02", weight_kg: null },
      ],
    });

    expect(result.bodyWeight.points.map((point) => point.date)).toEqual([
      "2026-06-01",
      "2026-07-01",
    ]);
    expect(result.bodyWeight.latest).toBe(178.6);
    expect(result.bodyWeight.changeLb).toBe(4.4);
  });
});
