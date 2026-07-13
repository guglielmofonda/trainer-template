import { describe, expect, it } from "vitest";
import type { Program } from "../../engine/types";
import { normalizeHistory } from "./normalize";
import { advanceProgramFromHevy } from "./advance";
import {
  parseDayIdFromTitle,
  parseWeekFromTitle,
  weekForWorkout,
  workoutImpact,
} from "./impact";
import { actualWeekVolume } from "./volume";
import type { HevyExerciseTemplate, HevySet, HevyWorkout } from "./types";

const LB_TO_KG = 0.45359237;

function toKg(lb: number) {
  return Math.round(lb * LB_TO_KG * 100) / 100;
}

function tpl(id: string, title: string, muscle: string, type = "weight_reps"): HevyExerciseTemplate {
  return { id, title, type, primary_muscle_group: muscle, secondary_muscle_groups: [], is_custom: false };
}

function set(lb: number | null, reps: number, rpe: number | null = 8, type = "normal"): HevySet {
  return {
    index: 0,
    type,
    weight_kg: lb == null ? null : toKg(lb),
    reps,
    rpe,
    distance_meters: null,
    duration_seconds: null,
    custom_metric: null,
  };
}

function workout(title: string, exercises: { id: string; title: string; sets: HevySet[] }[]): HevyWorkout {
  return {
    id: "w1",
    title,
    start_time: "2026-07-02T10:00:00Z",
    end_time: "2026-07-02T11:00:00Z",
    created_at: "2026-07-02T10:00:00Z",
    updated_at: "2026-07-02T11:00:00Z",
    exercises: exercises.map((e, i) => ({ index: i, title: e.title, exercise_template_id: e.id, sets: e.sets })),
  };
}

function program(): Program {
  const wave = {
    goal: "strength" as const,
    shape: "flat" as const,
    waveLength: 3,
    repsStart: 8,
    repsEnd: 8,
    setsStart: 3,
    setsEnd: 3,
    rirStart: 2,
    rirEnd: 2,
    intensityStart: 1,
    intensityEnd: 1,
  };
  return {
    id: "impact-mini",
    name: "Impact Mini",
    locked: false,
    cycle: { weeksOn: 2, weeksOff: 0, mesocycles: 1, unit: "lb", rounding: { increment: 5, mode: "nearest" } },
    days: [
      {
        id: "day-1",
        name: "Day 1",
        exercises: [
          {
            id: "squat",
            name: "Back Squat",
            muscle: "Quadriceps",
            compound: true,
            usesOpeningSingle: false,
            openingSingleRpe: 8,
            loadBasis: "max",
            e1rm: 100,
            rule: "calibration",
            wave,
            rounding: { increment: 5, mode: "nearest" },
          },
          {
            id: "leg-extension",
            name: "Leg Extension",
            muscle: "Quadriceps",
            compound: false,
            usesOpeningSingle: false,
            openingSingleRpe: 8,
            loadBasis: "work",
            workWeight: 100,
            rule: "double-progression",
            wave,
            rounding: { increment: 5, mode: "nearest" },
            repCap: 10,
          },
          {
            id: "leg-curl",
            name: "Seated Leg Curl",
            muscle: "Hamstrings",
            compound: false,
            usesOpeningSingle: false,
            openingSingleRpe: 8,
            loadBasis: "work",
            workWeight: 50,
            rule: "reps-to-failure",
            wave,
            rounding: { increment: 5, mode: "nearest" },
            repTarget: 10,
          },
          {
            id: "bench",
            name: "Bench Press",
            muscle: "Chest",
            compound: true,
            usesOpeningSingle: false,
            openingSingleRpe: 8,
            loadBasis: "max",
            e1rm: 100,
            rule: "set-threshold-rir",
            wave,
            rounding: { increment: 5, mode: "nearest" },
          },
        ],
      },
    ],
  };
}

const templates = [
  tpl("SQ", "Squat (Barbell)", "quadriceps"),
  tpl("LE", "Leg Extension (Machine)", "quadriceps"),
  tpl("LC", "Seated Leg Curl (Machine)", "hamstrings"),
  tpl("BN", "Bench Press (Barbell)", "chest"),
  tpl("FP", "Face Pull (Cable)", "shoulders"),
];

describe("workout impact", () => {
  it("parses day markers and week numbers from routine titles", () => {
    const prog = program();
    expect(parseDayIdFromTitle("W1 Day 1 [day-1]", prog)).toBe("day-1");
    expect(parseDayIdFromTitle("W1 Day 1 [missing-day]", prog)).toBeNull();
    expect(parseWeekFromTitle("W12 Ramp Day 1")).toBe(12);
    expect(parseWeekFromTitle("Unmarked workout")).toBeNull();
  });

  it("attributes in-block workouts to weeks and excludes pre-block history", () => {
    const start = "2026-07-02";
    expect(weekForWorkout({ title: "W3 Day 1", start_time: "2026-07-02T10:00:00Z" }, start, 10)).toBe(3);
    expect(weekForWorkout({ title: "Morning session", start_time: "2026-07-16T10:00:00Z" }, start, 10)).toBe(3);
    expect(weekForWorkout({ title: "W99 Day 1", start_time: "2026-07-02T10:00:00Z" }, start, 10)).toBe(10);
    expect(weekForWorkout({ title: "Before the block", start_time: "2026-06-01T10:00:00Z" }, start, 10)).toBeNull();
    expect(weekForWorkout({ title: "W1 from an older block", start_time: "2026-06-01T10:00:00Z" }, start, 10)).toBeNull();
  });

  it("reports above, on, below, skipped, extras, and lb-converted actual sets", () => {
    const prog = program();
    const w = workout("W1 Day 1 [day-1]", [
      { id: "SQ", title: "Squat (Barbell)", sets: [set(45, 8, null, "warmup"), set(100, 5, 8)] },
      { id: "LE", title: "Leg Extension (Machine)", sets: [set(100, 8, 8), set(100, 8, 8), set(100, 8, 8)] },
      { id: "LC", title: "Seated Leg Curl (Machine)", sets: [set(50, 8, 10)] },
      { id: "FP", title: "Face Pull (Cable)", sets: [set(30, 15, 9)] },
    ]);

    const impact = workoutImpact(prog, w, templates, 1);
    expect(impact.day?.id).toBe("day-1");
    expect(impact.exercises.find((e) => e.exercise.id === "squat")?.verdict).toBe("above");
    expect(impact.exercises.find((e) => e.exercise.id === "leg-extension")?.verdict).toBe("on");
    expect(impact.exercises.find((e) => e.exercise.id === "leg-curl")?.verdict).toBe("below");
    expect(impact.skipped.map((e) => e.exercise.id)).toContain("bench");
    expect(impact.extras.map((e) => e.title)).toEqual(["Face Pull (Cable)"]);
    const squatSets = impact.exercises.find((e) => e.exercise.id === "squat")?.actualSets ?? [];
    expect(squatSets[0]).toMatchObject({ weight: 45, reps: 8, type: "warmup" });
    expect(squatSets[1]).toMatchObject({ weight: 100, reps: 5, type: "normal" });
  });

  it("uses the same applied changes as advanceProgramFromHevy for a single-workout history", () => {
    const prog = program();
    const w = workout("W1 Day 1 [day-1]", [
      { id: "SQ", title: "Squat (Barbell)", sets: [set(100, 5, 8)] },
      { id: "LE", title: "Leg Extension (Machine)", sets: [set(100, 10, 8), set(100, 10, 8), set(100, 10, 8)] },
      { id: "LC", title: "Seated Leg Curl (Machine)", sets: [set(50, 8, 10)] },
    ]);
    const history = normalizeHistory([w], templates);
    const advanced = advanceProgramFromHevy(prog, history, 1);
    const impact = workoutImpact(prog, w, templates, 1);
    const impactChanges = impact.exercises.flatMap((row) => (row.change ? [row.change] : []));

    expect(impactChanges).toEqual(advanced.changes);
  });

  it("assumes missing RPE is RPE 9 for impact decisions", () => {
    const prog = program();
    const w = workout("W1 Day 1 [day-1]", [
      { id: "SQ", title: "Squat (Barbell)", sets: [set(100, 5, null)] },
    ]);
    const row = workoutImpact(prog, w, templates, 1).exercises.find((e) => e.exercise.id === "squat")!;
    expect(row.decisionNote).toContain("RPE 9");
  });
});

const templatesWithSubs = [
  ...templates,
  tpl("CP", "Chest Press (Machine)", "chest"),
  tpl("CF", "Cable Fly (Cable)", "chest"),
  tpl("NC", "Neck Curl (Plate)", "neck"),
];

describe("exercise swaps", () => {
  it("credits a same-muscle substitute: sets tracked on the slot, anchor held, nothing skipped", () => {
    const prog = program();
    const w = workout("W1 Day 1 [day-1]", [
      { id: "SQ", title: "Squat (Barbell)", sets: [set(100, 5, 8)] },
      { id: "LE", title: "Leg Extension (Machine)", sets: [set(100, 8, 8), set(100, 8, 8), set(100, 8, 8)] },
      { id: "LC", title: "Seated Leg Curl (Machine)", sets: [set(50, 8, 10)] },
      // Bench Press was planned; a machine chest press was done instead.
      { id: "CP", title: "Chest Press (Machine)", sets: [set(120, 10, 8), set(120, 10, 8)] },
    ]);

    const impact = workoutImpact(prog, w, templatesWithSubs, 1);
    const bench = impact.exercises.find((e) => e.exercise.id === "bench")!;
    expect(bench.status).toBe("swapped");
    expect(bench.templateTitle).toBe("Chest Press (Machine)");
    expect(bench.actualSets).toHaveLength(2);
    expect(bench.actualSets[0]).toMatchObject({ weight: 120, reps: 10 });
    expect(bench.verdict).toBe("on");
    // A different movement never moves the planned lift's anchor.
    expect(bench.change).toBeNull();
    expect(bench.decisionNote).toContain("Swapped for Chest Press (Machine)");
    expect(bench.decisionNote).toContain("Chest volume");
    // The substitute is claimed: no longer an extra, and the slot isn't skipped.
    expect(impact.skipped).toHaveLength(0);
    expect(impact.extras).toHaveLength(0);
    expect(impact.summary.on).toBeGreaterThanOrEqual(1);
  });

  it("prefers the closest movement when several same-muscle substitutes exist; the rest stay extras", () => {
    const prog = program();
    const w = workout("W1 Day 1 [day-1]", [
      { id: "SQ", title: "Squat (Barbell)", sets: [set(100, 5, 8)] },
      { id: "LE", title: "Leg Extension (Machine)", sets: [set(100, 8, 8), set(100, 8, 8), set(100, 8, 8)] },
      { id: "LC", title: "Seated Leg Curl (Machine)", sets: [set(50, 8, 10)] },
      // Fly listed first in the workout, but the press is the closer movement to Bench Press.
      { id: "CF", title: "Cable Fly (Cable)", sets: [set(30, 12, 8)] },
      { id: "CP", title: "Chest Press (Machine)", sets: [set(120, 10, 8)] },
    ]);

    const impact = workoutImpact(prog, w, templatesWithSubs, 1);
    const bench = impact.exercises.find((e) => e.exercise.id === "bench")!;
    expect(bench.status).toBe("swapped");
    expect(bench.templateTitle).toBe("Chest Press (Machine)");
    expect(impact.extras.map((e) => e.title)).toEqual(["Cable Fly (Cable)"]);
    expect(impact.extras[0].muscle).toBe("Chest");
  });

  it("never swaps across muscle groups", () => {
    const prog = program();
    const w = workout("W1 Day 1 [day-1]", [
      { id: "SQ", title: "Squat (Barbell)", sets: [set(100, 5, 8)] },
      { id: "LE", title: "Leg Extension (Machine)", sets: [set(100, 8, 8)] },
      { id: "LC", title: "Seated Leg Curl (Machine)", sets: [set(50, 8, 10)] },
      // Shoulders ≠ Chest: Face Pull must not be claimed for the skipped bench.
      { id: "FP", title: "Face Pull (Cable)", sets: [set(30, 15, 9)] },
    ]);

    const impact = workoutImpact(prog, w, templatesWithSubs, 1);
    expect(impact.skipped.map((e) => e.exercise.id)).toContain("bench");
    expect(impact.extras.map((e) => e.title)).toEqual(["Face Pull (Cable)"]);
  });
});

describe("actual week volume", () => {
  it("counts planned, swapped, and extra working sets by muscle; warm-ups excluded", () => {
    const prog = program();
    const w = workout("W1 Day 1 [day-1]", [
      // 1 warm-up (not counted) + 2 working sets.
      { id: "SQ", title: "Squat (Barbell)", sets: [set(45, 8, null, "warmup"), set(100, 5, 8), set(100, 5, 8)] },
      // 4 working sets where 3 were planned — the extra set counts.
      { id: "LE", title: "Leg Extension (Machine)", sets: [set(100, 8, 8), set(100, 8, 8), set(100, 8, 8), set(100, 8, 8)] },
      // Swap for the planned bench: 2 sets credited to Chest.
      { id: "CP", title: "Chest Press (Machine)", sets: [set(120, 10, 8), set(120, 10, 8)] },
      // Unplanned extra on an unplanned muscle.
      { id: "FP", title: "Face Pull (Cable)", sets: [set(30, 15, 9)] },
      // Extra whose Hevy muscle doesn't map to an engine group.
      { id: "NC", title: "Neck Curl (Plate)", sets: [set(10, 15, 8)] },
    ]);

    const impact = workoutImpact(prog, w, templatesWithSubs, 1);
    const vol = actualWeekVolume(prog, [impact], 1);

    const quads = vol.byMuscle.find((m) => m.muscle === "Quadriceps")!;
    expect(quads.sets).toBe(6); // 2 squat + 4 leg extension, warm-up excluded
    expect(quads.plannedSets).toBe(6);
    expect(quads.fromPlanned).toBe(6);

    const chest = vol.byMuscle.find((m) => m.muscle === "Chest")!;
    expect(chest.sets).toBe(2);
    expect(chest.fromSwaps).toBe(2);
    expect(chest.plannedSets).toBe(3);

    const shoulders = vol.byMuscle.find((m) => m.muscle === "Shoulders")!;
    expect(shoulders.sets).toBe(1);
    expect(shoulders.fromExtras).toBe(1);
    expect(shoulders.plannedSets).toBe(0);

    // Planned but untrained stays visible at zero.
    const hams = vol.byMuscle.find((m) => m.muscle === "Hamstrings")!;
    expect(hams.sets).toBe(0);
    expect(hams.plannedSets).toBe(3);

    expect(vol.unmappedSets).toBe(1);
    expect(vol.totalSets).toBe(9);
  });

  it("aggregates only the requested week", () => {
    const prog = program();
    const w = workout("W2 Day 1 [day-1]", [
      { id: "SQ", title: "Squat (Barbell)", sets: [set(100, 5, 8)] },
    ]);
    const week2 = workoutImpact(prog, w, templatesWithSubs, 2);
    const vol = actualWeekVolume(prog, [week2], 1);
    const quads = vol.byMuscle.find((m) => m.muscle === "Quadriceps")!;
    expect(quads.sets).toBe(0);
  });
});
