/**
 * get_week_volume `actual` payload: real sets from Hevy folded into the volume
 * check — planned lifts, same-muscle swaps, and extras all count. Kept separate
 * from tools.test.ts so this integration has its own guard.
 */
import { describe, expect, it } from "vitest";
import { runCoachTool } from "./tools";
import { fakeHevy, fixtureTemplates, fixtureWorkouts, lbToKg, makeCtx } from "./testFixtures";
import type { HevyWorkout } from "../integrations/hevy/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

async function volume(ctx: Parameters<typeof runCoachTool>[2]): Promise<Any> {
  const out = await runCoachTool("get_week_volume", {}, ctx);
  expect(out.isError, JSON.stringify(out.result)).toBe(false);
  return out.result as Any;
}

describe("get_week_volume actuals", () => {
  it("returns planned volume plus actual sets done from Hevy", async () => {
    const { ctx } = makeCtx({ hevy: fakeHevy({ workouts: fixtureWorkouts() }) });
    const r = await volume(ctx);

    // Planned side unchanged.
    expect(r.week).toBe(2);
    expect(r.totalSets).toBe(16);

    // Actual side: the Thu W2 workout (bench 3 working sets, RDL 2), warm-up excluded;
    // the May workout falls outside week 2 and is ignored.
    expect(r.actual.workoutsCounted).toBe(1);
    expect(r.actual.totalSetsDone).toBe(5);
    const chest = r.actual.byMuscle.find((m: Any) => m.muscle === "Chest");
    expect(chest).toMatchObject({ setsDone: 3, plannedSets: 3, fromPlanned: 3, fromSwaps: 0 });
    const quads = r.actual.byMuscle.find((m: Any) => m.muscle === "Quadriceps");
    expect(quads).toMatchObject({ setsDone: 0, plannedSets: 3 });
    expect(r.actual.swaps).toEqual([]);
    expect(r.actual.extras).toEqual([]);
  });

  it("reports same-muscle substitutions as swaps with their sets credited", async () => {
    const set = (lb: number, reps: number) => ({
      index: 0,
      type: "normal",
      weight_kg: lbToKg(lb),
      reps,
      distance_meters: null,
      duration_seconds: null,
      rpe: 8,
      custom_metric: null,
    });
    const swapWorkout: HevyWorkout = {
      id: "w-swap",
      title: "W2 Full Body A (Sat 07-11) [day-a]",
      start_time: "2026-07-11T09:00:00Z",
      end_time: "2026-07-11T10:00:00Z",
      created_at: "2026-07-11T10:00:00Z",
      updated_at: "2026-07-11T10:00:00Z",
      exercises: [
        { index: 0, title: "Squat (Barbell)", exercise_template_id: "tmpl-squat", sets: [set(255, 5), set(255, 5), set(255, 5)] },
        // Planned: Chest Supported Row — did an iso row machine instead (same muscle).
        { index: 1, title: "Iso-Lateral Row (Machine)", exercise_template_id: "tmpl-iso", sets: [set(90, 10), set(90, 10), set(90, 10)] },
        { index: 2, title: "Hammer Curl (Dumbbell)", exercise_template_id: "tmpl-curl", sets: [set(30, 10), set(30, 10)] },
      ],
    };
    const templates = [
      ...fixtureTemplates(),
      {
        id: "tmpl-iso",
        title: "Iso-Lateral Row (Machine)",
        type: "weight_reps",
        primary_muscle_group: "upper_back",
        secondary_muscle_groups: [],
        is_custom: false,
      },
    ];
    const { ctx } = makeCtx({ hevy: fakeHevy({ templates, workouts: [swapWorkout] }) });
    const r = await volume(ctx);

    expect(r.actual.swaps).toEqual([
      { date: "2026-07-11", planned: "Chest Supported Row", did: "Iso-Lateral Row (Machine)", workingSets: 3 },
    ]);
    const back = r.actual.byMuscle.find((m: Any) => m.muscle === "Back");
    expect(back).toMatchObject({ setsDone: 3, plannedSets: 3, fromSwaps: 3, fromPlanned: 0 });
    expect(r.actual.extras).toEqual([]);
  });

  it("degrades to { unavailable } without a Hevy key — planned volume still returned", async () => {
    const { ctx } = makeCtx({ hevy: null });
    const r = await volume(ctx);
    expect(r.totalSets).toBe(16);
    expect(r.byMuscle.length).toBeGreaterThan(0);
    expect(r.actual.unavailable).toContain("server-side Hevy connection");
  });
});
