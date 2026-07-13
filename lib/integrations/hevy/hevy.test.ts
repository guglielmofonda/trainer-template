import { describe, expect, it } from "vitest";
import type { Program } from "../../engine/types";
import { estimate1RM } from "../../engine/e1rm";
import { rampProgram, seedProgram } from "../../domain/seed";
import type { HevyExerciseTemplate, HevySet, HevyWorkout } from "./types";
import { normalizeHistory } from "./normalize";
import { matchProgramToHistory, parseTitle, scoreMatch } from "./match";
import { calibrate } from "./calibrate";
import { applyCalibration } from "./apply";
import { exportWeekToHevy } from "./export";
import { advanceProgramFromHevy } from "./advance";

/* ------------------------------------------------------------------ fixtures */

const NOW = "2026-06-29T00:00:00Z";

const T = {
  squat: tpl("SQ", "Squat (Barbell)", "quadriceps"),
  frontSquat: tpl("FSQ", "Front Squat (Barbell)", "quadriceps"),
  bench: tpl("BN", "Bench Press (Barbell)", "chest"),
  inclineBarbell: tpl("INB", "Incline Bench Press (Barbell)", "chest"),
  inclineDumbbell: tpl("IND", "Incline Bench Press (Dumbbell)", "chest"),
  legExt: tpl("LE", "Leg Extension (Machine)", "quadriceps"),
  legPress: tpl("LP", "Leg Press (Machine)", "quadriceps"),
  latPulldown: tpl("LAT", "Lat Pulldown (Cable)", "lats"),
  pullUp: tpl("PU", "Pull Up", "lats", "bodyweight_reps"),
  facePull: tpl("FP", "Face Pull (Cable)", "shoulders"),
  cableCrunch: tpl("CC", "Cable Crunch", "abdominals"),
  declineCrunch: tpl("DC", "Decline Crunch", "abdominals", "bodyweight_reps"),
};
const ALL_TEMPLATES = Object.values(T);

function tpl(id: string, title: string, muscle: string, type = "weight_reps"): HevyExerciseTemplate {
  return { id, title, type, primary_muscle_group: muscle, secondary_muscle_groups: [], is_custom: false };
}
function set(weight_kg: number | null, reps: number | null, rpe: number | null = null, type = "normal"): HevySet {
  return { index: 0, type, weight_kg, reps, rpe, distance_meters: null, duration_seconds: null, custom_metric: null };
}
function workout(date: string, exercises: { id: string; title: string; sets: HevySet[] }[]): HevyWorkout {
  return {
    id: `w-${date}`,
    title: "Session",
    start_time: `${date}T10:00:00Z`,
    end_time: `${date}T11:00:00Z`,
    created_at: `${date}T10:00:00Z`,
    updated_at: `${date}T11:00:00Z`,
    exercises: exercises.map((e, i) => ({ index: i, title: e.title, exercise_template_id: e.id, sets: e.sets })),
  };
}

/** A history where every template appears at least once (so the matcher sees them). */
function richWorkouts(): HevyWorkout[] {
  return [
    // 4 squat sessions w/ RPE → high confidence; best is 140×3 @8.
    workout("2026-06-02", [{ id: "SQ", title: "Squat (Barbell)", sets: [set(60, 5, null, "warmup"), set(130, 4, 7), set(135, 3, 8)] }]),
    workout("2026-06-09", [{ id: "SQ", title: "Squat (Barbell)", sets: [set(132, 3, 8)] }]),
    workout("2026-06-16", [
      { id: "SQ", title: "Squat (Barbell)", sets: [set(140, 3, 8)] },
      // second Leg Extension session (top 62.5, same rep spread) so accessories have >=2 sessions
      { id: "LE", title: "Leg Extension (Machine)", sets: [set(62.5, 10), set(60, 12), set(60, 11)] },
    ]),
    workout("2026-06-23", [{ id: "SQ", title: "Squat (Barbell)", sets: [set(138, 3, 8.5)] }]),
    // distractor compounds present in the catalog so the matcher must disambiguate
    workout("2026-06-03", [
      { id: "FSQ", title: "Front Squat (Barbell)", sets: [set(90, 5, 8)] },
      { id: "BN", title: "Bench Press (Barbell)", sets: [set(100, 5, 8)] },
      { id: "INB", title: "Incline Bench Press (Barbell)", sets: [set(80, 6, 8)] },
      { id: "IND", title: "Incline Bench Press (Dumbbell)", sets: [set(30, 8, 8)] },
      { id: "LE", title: "Leg Extension (Machine)", sets: [set(60, 12), set(60, 11), set(62.5, 10)] },
      { id: "LP", title: "Leg Press (Machine)", sets: [set(200, 10)] },
      { id: "LAT", title: "Lat Pulldown (Cable)", sets: [set(70, 10)] },
      { id: "PU", title: "Pull Up", sets: [set(null, 8), set(null, 7)] },
    ]),
    // Face Pull trained a lot but absent from the program → untracked recommendation.
    ...["2026-06-04", "2026-06-07", "2026-06-11", "2026-06-18", "2026-06-25"].map((d) =>
      workout(d, [{ id: "FP", title: "Face Pull (Cable)", sets: [set(25, 15), set(25, 15)] }]),
    ),
  ];
}

/* -------------------------------------------------------------------- matcher */

describe("matcher", () => {
  const history = normalizeHistory(richWorkouts(), ALL_TEMPLATES, { windowDays: 120, now: NOW });

  function matchFor(program: Program, name: string) {
    const matches = matchProgramToHistory(program, history);
    return matches.find((m) => m.exerciseName === name);
  }

  it("maps Back Squat to barbell Squat, not Front Squat", () => {
    const prog = miniProgram([{ name: "Back Squat", muscle: "Quadriceps", basis: "max", value: 100 }]);
    const m = matchFor(prog, "Back Squat");
    expect(m?.templateTitle).toBe("Squat (Barbell)");
  });

  it("maps Front Squat to Front Squat", () => {
    const prog = miniProgram([{ name: "Front Squat", muscle: "Quadriceps", basis: "work", value: 50 }]);
    expect(matchFor(prog, "Front Squat")?.templateTitle).toBe("Front Squat (Barbell)");
  });

  it("does not confuse Leg Extension with Leg Press", () => {
    const prog = miniProgram([{ name: "Leg Extension", muscle: "Quadriceps", basis: "work", value: 45 }]);
    expect(matchFor(prog, "Leg Extension")?.templateTitle).toBe("Leg Extension (Machine)");
  });

  it("uses equipment to pick Incline DB Press over the barbell version", () => {
    const prog = miniProgram([{ name: "Incline DB Press", muscle: "Chest", basis: "work", value: 24 }]);
    expect(matchFor(prog, "Incline DB Press")?.templateTitle).toBe("Incline Bench Press (Dumbbell)");
  });

  it("maps the new crunch variants without crossing cable/bodyweight variants", () => {
    const h = normalizeHistory(
      [
        workout("2026-06-10", [
          { id: "CC", title: "Cable Crunch", sets: [set(30, 12)] },
          { id: "DC", title: "Decline Crunch", sets: [set(null, 12)] },
        ]),
      ],
      [T.cableCrunch, T.declineCrunch],
      { windowDays: 120, now: NOW },
    );
    const prog = miniProgram([
      { name: "Cable Crunch", muscle: "Abs", basis: "work", value: 30 },
      { name: "Decline Crunch", muscle: "Abs", basis: "work", value: 0 },
    ]);
    const matches = matchProgramToHistory(prog, h);
    expect(matches.find((m) => m.exerciseName === "Cable Crunch")?.templateTitle).toBe("Cable Crunch");
    expect(matches.find((m) => m.exerciseName === "Decline Crunch")?.templateTitle).toBe("Decline Crunch");
  });

  it("maps flat Bench Press to the flat barbell bench, not incline", () => {
    const prog = miniProgram([{ name: "Bench Press", muscle: "Chest", basis: "max", value: 100 }]);
    expect(matchFor(prog, "Bench Press")?.templateTitle).toBe("Bench Press (Barbell)");
  });

  it("scoreMatch vetoes excluded tokens", () => {
    const idf = { weight: () => 1 };
    const rule = { keywords: ["squat"], exclude: ["front"] };
    expect(scoreMatch(rule, "Front Squat (Barbell)", idf)).toBe(0);
    expect(scoreMatch(rule, "Squat (Barbell)", idf)).toBeGreaterThan(0.9);
  });

  it("parseTitle splits equipment from the core and rewrites abbreviations", () => {
    const p = parseTitle("Incline DB Press");
    expect(p.core).toContain("incline");
    expect(p.core).toContain("press");
    expect(p.equipment.has("dumbbell")).toBe(true);
  });
});

/* ------------------------------------------------------------------ normalize */

describe("normalizeHistory", () => {
  const history = normalizeHistory(richWorkouts(), ALL_TEMPLATES, { windowDays: 120, now: NOW });

  it("excludes warmup sets and counts sessions", () => {
    const squat = history.byTemplate.get("SQ")!;
    expect(squat.sessions).toBe(4);
    // first squat session had a warmup (60×5) that must not be a working set
    expect(squat.workingSets.every((s) => s.type !== "warmup")).toBe(true);
    expect(squat.workingSets.some((s) => s.weightKg === 60)).toBe(false);
  });

  it("maps Hevy muscles to engine muscle groups", () => {
    expect(history.byTemplate.get("LAT")!.muscle).toBe("Back");
    expect(history.byTemplate.get("SQ")!.muscle).toBe("Quadriceps");
  });

  it("keeps bodyweight sets (null weight) as working sets", () => {
    const pull = history.byTemplate.get("PU")!;
    expect(pull.workingSets.length).toBe(2);
    expect(pull.workingSets[0].weightKg).toBeNull();
  });
});

/* ------------------------------------------------------------------ calibrate */

describe("calibrate", () => {
  const history = normalizeHistory(richWorkouts(), ALL_TEMPLATES, { windowDays: 120, now: NOW });

  it("estimates a max-basis e1RM from the best RPE set using the engine math", () => {
    const prog = miniProgram([{ name: "Back Squat", muscle: "Quadriceps", basis: "max", value: 100 }]);
    const matches = matchProgramToHistory(prog, history);
    const report = calibrate(prog, history, matches, { now: NOW });
    const squat = report.exercises[0];

    // Robust estimate = median of the top-3 single-set e1RMs (not the single max),
    // so the lone 140×3@8 (~162) is tempered by the next-best sets → 160 kg.
    expect(squat.suggested).toBe(160);
    expect(squat.confidence).toBe("high");
    expect(squat.usedRpeFraction).toBe(1);
    // The most informative single set is still surfaced for transparency.
    expect(squat.bestSet?.weightKg).toBe(140);
    expect(squat.bestSet?.e1rmKg).toBeCloseTo(estimate1RM(140, 3, 8), 5);
  });

  it("suggests a working weight for accessories from recent top sets", () => {
    const prog = miniProgram([{ name: "Leg Extension", muscle: "Quadriceps", basis: "work", value: 40 }]);
    const matches = matchProgramToHistory(prog, history);
    const report = calibrate(prog, history, matches, { now: NOW });
    const le = report.exercises[0];
    expect(le.suggested).toBe(62.5); // top set of the only session
    expect(le.repRange).toEqual({ min: 10, median: 11, max: 12 });
  });

  it("treats bodyweight pull-ups as workWeight 0", () => {
    const prog = miniProgram([{ name: "Weighted Pull-Up", muscle: "Back", basis: "work", value: 0, compound: true }]);
    const matches = matchProgramToHistory(prog, history);
    const report = calibrate(prog, history, matches, { now: NOW });
    expect(report.exercises[0].suggested).toBe(0);
    expect(report.exercises[0].rationale).toMatch(/bodyweight/i);
  });

  it("marks unmatched lifts as no-history and surfaces untracked lifts", () => {
    const prog = miniProgram([{ name: "Calf Raise On The Moon", muscle: "Calves", basis: "work", value: 50 }]);
    const matches = matchProgramToHistory(prog, history);
    const report = calibrate(prog, history, matches, { now: NOW });
    expect(report.exercises[0].confidence).toBe("none");
    expect(report.recommendations.some((r) => r.kind === "no-history")).toBe(true);
    const untracked = report.recommendations.find((r) => r.kind === "untracked-lift");
    expect(untracked?.detail).toMatch(/Face Pull/);
  });

  it("conservatively reads non-RPE sets (assumed RPE, capped confidence)", () => {
    const noRpe = [
      workout("2026-06-05", [{ id: "BN", title: "Bench Press (Barbell)", sets: [set(100, 5)] }]),
      workout("2026-06-12", [{ id: "BN", title: "Bench Press (Barbell)", sets: [set(100, 5)] }]),
      workout("2026-06-19", [{ id: "BN", title: "Bench Press (Barbell)", sets: [set(102.5, 5)] }]),
    ];
    const h = normalizeHistory(noRpe, ALL_TEMPLATES, { windowDays: 120, now: NOW });
    const prog = miniProgram([{ name: "Bench Press", muscle: "Chest", basis: "max", value: 100 }]);
    const matches = matchProgramToHistory(prog, h);
    const report = calibrate(prog, h, matches, { now: NOW });
    const bench = report.exercises[0];
    expect(bench.usedRpeFraction).toBe(0);
    expect(bench.confidence).not.toBe("high"); // capped because no RPE was logged
    // With no RPE we assume ~RPE 9 (near failure): the estimate lands BELOW the
    // optimistic RPE-8 read and ABOVE the failure (RPE-10) read — conservative middle.
    expect(bench.suggested!).toBeLessThan(estimate1RM(102.5, 5, 8));
    expect(bench.suggested!).toBeGreaterThan(estimate1RM(102.5, 5, 10));
  });
});

/* ---------------------------------------------------------------------- apply */

describe("applyCalibration", () => {
  const history = normalizeHistory(richWorkouts(), ALL_TEMPLATES, { windowDays: 120, now: NOW });

  it("writes confident suggestions and leaves the input program untouched", () => {
    const prog = miniProgram([
      { name: "Back Squat", muscle: "Quadriceps", basis: "max", value: 100 },
      { name: "Leg Extension", muscle: "Quadriceps", basis: "work", value: 40 },
    ]);
    const matches = matchProgramToHistory(prog, history);
    const report = calibrate(prog, history, matches, { now: NOW });
    const { program: next, changes } = applyCalibration(prog, report, { minConfidence: "medium" });

    expect(changes.length).toBe(2);
    expect(next.days[0].exercises[0].e1rm).toBeGreaterThan(150);
    expect(next.days[0].exercises[1].workWeight).toBe(62.5);
    // original unchanged
    expect(prog.days[0].exercises[0].e1rm).toBe(100);
    expect(prog.days[0].exercises[1].workWeight).toBe(40);
  });

  it("skips below-confidence and unmatched suggestions", () => {
    const prog = miniProgram([{ name: "Mystery Machine Thruster", muscle: "Glutes", basis: "work", value: 50 }]);
    const matches = matchProgramToHistory(prog, history);
    const report = calibrate(prog, history, matches, { now: NOW });
    const { changes, skipped } = applyCalibration(prog, report);
    expect(changes.length).toBe(0);
    expect(skipped.length).toBe(1);
  });
});

/* -------------------------------------------------- integration on real seed */

describe("end-to-end on the seed program", () => {
  it("calibrates the seed program's squat and applies without error", () => {
    const program = seedProgram();
    const history = normalizeHistory(richWorkouts(), ALL_TEMPLATES, { windowDays: 120, now: NOW });
    const matches = matchProgramToHistory(program, history);
    const report = calibrate(program, history, matches, { now: NOW });

    const squat = report.exercises.find((e) => e.exerciseName === "Back Squat");
    expect(squat?.matchedTitle).toBe("Squat (Barbell)");
    expect(squat?.suggested).toBeGreaterThan(150);

    const { program: next, changes } = applyCalibration(program, report);
    expect(changes.length).toBeGreaterThan(0);
    // seed squat placeholder is 185 lb; calibration should have raised it
    const seedSquat = next.days[0].exercises[0];
    expect(seedSquat.name).toBe("Back Squat");
    expect(seedSquat.e1rm!).toBeGreaterThan(185);
  });
});

/* --------------------------------------------------------------- Hevy export */

describe("exportWeekToHevy", () => {
  it("converts lb programs to Hevy weight_kg but keeps dry-run labels in lb", async () => {
    const prog = miniProgram([{ name: "Leg Extension", muscle: "Quadriceps", basis: "work", value: 100 }]);
    prog.cycle.unit = "lb";
    prog.cycle.rounding = { increment: 5, mode: "nearest" };
    prog.days[0].exercises[0].rounding = { increment: 5, mode: "nearest" };

    const client = {
      getAllTemplates: async () => [T.legExt],
    };
    const result = await exportWeekToHevy(client as never, prog, {
      dryRun: true,
      createCustom: false,
    });

    const exercise = result.routines[0].exercises[0];
    expect(exercise.sets[0].weight_kg).toBeCloseTo(45.36, 2);
    expect(exercise._label).toContain("100lb");
    expect(exercise._label).not.toContain("45.36lb");
  });

  it("exports a `drop-set`-rule lift as Hevy dropset sets", async () => {
    const prog = miniProgram([{ name: "Triceps Pushdown", muscle: "Triceps", basis: "work", value: 25, rule: "drop-set" }]);
    const client = { getAllTemplates: async () => [tpl("TP", "Triceps Pushdown", "triceps")] };
    const result = await exportWeekToHevy(client as never, prog, { dryRun: true, createCustom: false });
    const ex = result.routines[0].exercises[0];
    expect(ex.sets.every((s) => s.type === "dropset")).toBe(true);
    expect(ex.rest_seconds).toBe(60);
    expect(ex.notes.toLowerCase()).toContain("dropset");
  });

  it("prepends explicitly marked warm-up sets without changing work-set count", async () => {
    const prog = miniProgram([{ name: "Back Squat", muscle: "Quadriceps", basis: "max", value: 100 }]);
    prog.days[0].exercises[0].warmup = { profile: "standard", startLoad: 20 };
    const client = { getAllTemplates: async () => [T.squat] };
    const result = await exportWeekToHevy(client as never, prog, { dryRun: true, createCustom: false });
    const ex = result.routines[0].exercises[0];

    expect(ex.sets.map((set) => set.type)).toEqual([
      "warmup",
      "warmup",
      "warmup",
      "normal",
      "normal",
      "normal",
    ]);
    expect(ex.sets.filter((set) => set.type === "normal")).toHaveLength(3);
    expect(ex.notes).toContain("Warm-up (marked)");
    expect(ex._label).toContain("warm-up");
  });

  it("exports bodyweight rep ranges with null weight_kg", async () => {
    const prog = miniProgram([{ name: "Weighted Pull-Up", muscle: "Back", basis: "work", value: 0, compound: true }]);
    prog.days[0].exercises[0].repCap = 12;
    const client = { getAllTemplates: async () => [T.pullUp] };
    const result = await exportWeekToHevy(client as never, prog, { dryRun: true, createCustom: false });
    const setPlan = result.routines[0].exercises[0].sets[0];
    expect(setPlan.weight_kg).toBeNull();
    expect(setPlan.reps).toBeNull();
    expect(setPlan.rep_range).toEqual({ start: 5, end: 12 });
  });
});

describe("weekly advance (autoregulation from Hevy)", () => {
  it("advances a trained accessory's working weight when it hits the cap", () => {
    const prog = miniProgram([{ name: "Leg Extension", muscle: "Quadriceps", basis: "work", value: 100 }]);
    const h = normalizeHistory(
      [workout("2026-06-28", [{ id: "LE", title: "Leg Extension (Machine)", sets: [set(100, 9, 8), set(100, 9, 8), set(100, 9, 8)] }])],
      [tpl("LE", "Leg Extension (Machine)", "quadriceps")],
      { windowDays: 9, now: NOW },
    );
    const { nextProgram, changes, trained } = advanceProgramFromHevy(prog, h, 1);
    expect(trained).toBe(true);
    expect(nextProgram.days[0].exercises[0].workWeight!).toBeGreaterThan(100);
    expect(changes.find((c) => c.exerciseName === "Leg Extension")?.field).toBe("workWeight");
  });

  it("advances a max lift whose rule emits a load STEP (not an e1RM delta) — the critical-bug regression", () => {
    // set-threshold-rir (squat/bench/OHP) and top-set-backoff (deadlift) emit
    // { loadDeltaAbs, e1rmDelta: 0 }; the advance must convert that to an e1RM bump.
    const prog = miniProgram([{ name: "Back Squat", muscle: "Quadriceps", basis: "max", value: 100 }]);
    const h = normalizeHistory(
      [workout("2026-06-28", [{ id: "SQ", title: "Squat (Barbell)", sets: [set(80, 5, 8), set(80, 5, 8), set(80, 5, 8)] }])],
      [tpl("SQ", "Squat (Barbell)", "quadriceps")],
      { windowDays: 9, now: NOW },
    );
    const { nextProgram, changes } = advanceProgramFromHevy(prog, h, 1);
    expect(nextProgram.days[0].exercises[0].e1rm!).toBeGreaterThan(100); // was stuck at 100 before the fix
    expect(changes.find((c) => c.exerciseName === "Back Squat")?.field).toBe("e1rm");
  });

  it("caps a runaway upward e1RM jump at +15%/week (bad-data safety)", () => {
    const prog = miniProgram([{ name: "Back Squat", muscle: "Quadriceps", basis: "max", value: 100, rule: "calibration" }]);
    // a very heavy set implies a far-higher 1RM; the weekly cap must hold it to +15%.
    const h = normalizeHistory(
      [workout("2026-06-28", [{ id: "SQ", title: "Squat (Barbell)", sets: [set(200, 3, 9)] }])],
      [tpl("SQ", "Squat (Barbell)", "quadriceps")],
      { windowDays: 9, now: NOW },
    );
    const { nextProgram } = advanceProgramFromHevy(prog, h, 1);
    expect(nextProgram.days[0].exercises[0].e1rm!).toBeLessThanOrEqual(115);
    expect(nextProgram.days[0].exercises[0].e1rm!).toBeGreaterThan(100);
  });

  it("advances a max lift's e1RM from the logged calibration set", () => {
    const prog = miniProgram([{ name: "Back Squat", muscle: "Quadriceps", basis: "max", value: 100, rule: "calibration" }]);
    const h = normalizeHistory(
      [workout("2026-06-28", [{ id: "SQ", title: "Squat (Barbell)", sets: [set(100, 5, 8)] }])],
      [tpl("SQ", "Squat (Barbell)", "quadriceps")],
      { windowDays: 9, now: NOW },
    );
    const { nextProgram, changes } = advanceProgramFromHevy(prog, h, 1);
    expect(nextProgram.days[0].exercises[0].e1rm!).toBeGreaterThan(100);
    expect(changes.find((c) => c.exerciseName === "Back Squat")?.field).toBe("e1rm");
  });

  it("holds (no change) exercises with no matching training", () => {
    const prog = miniProgram([{ name: "Bench Press", muscle: "Chest", basis: "max", value: 100 }]);
    const { nextProgram, trained } = advanceProgramFromHevy(prog, normalizeHistory([], [], { windowDays: 9, now: NOW }), 1);
    expect(trained).toBe(false);
    expect(nextProgram.days[0].exercises[0].e1rm).toBe(100);
  });
});

describe("full-body guarantee (seed program)", () => {
  it("every ramp and main training day hits arms, calves, and abs", () => {
    for (const program of [seedProgram(), rampProgram()]) {
      for (const day of program.days) {
        const muscles = new Set(day.exercises.map((e) => e.muscle));
        expect(muscles.has("Biceps"), `${program.name} / ${day.name} biceps`).toBe(true);
        expect(muscles.has("Triceps"), `${program.name} / ${day.name} triceps`).toBe(true);
        expect(muscles.has("Calves"), `${program.name} / ${day.name} calves`).toBe(true);
        expect(muscles.has("Abs"), `${program.name} / ${day.name} abs`).toBe(true);
      }
    }
  });
});

/* ----------------------------------------------- review-hardening regressions */

describe("review fixes", () => {
  it("counts the same lift logged twice in one workout as ONE session (no inflated confidence)", () => {
    const tShrug = tpl("SQ", "Squat (Barbell)", "quadriceps");
    const w = workout("2026-06-10", [
      { id: "SQ", title: "Squat (Barbell)", sets: [set(140, 3, 8)] }, // main
      { id: "SQ", title: "Squat (Barbell)", sets: [set(120, 5, 7)] }, // back-off block, same workout
    ]);
    const h = normalizeHistory([w], [tShrug], { windowDays: 120, now: NOW });
    const squat = h.byTemplate.get("SQ")!;
    expect(squat.sessions).toBe(1); // not 2
    expect(squat.perSession.length).toBe(1);
    expect(squat.workingSets.length).toBe(2); // both sets retained
    expect(squat.perSession[0].sets).toBe(2);

    // A single workout must not reach "high" confidence (needs >=3 sessions).
    const prog = miniProgram([{ name: "Back Squat", muscle: "Quadriceps", basis: "max", value: 100 }]);
    const report = calibrate(prog, h, matchProgramToHistory(prog, h), { now: NOW });
    expect(report.exercises[0].confidence).not.toBe("high");
  });

  it("requires the movement token: Seated Leg Curl matches a curl, never a Leg Press", () => {
    const templates = [
      tpl("SLP", "Seated Leg Press (Machine)", "quadriceps"),
      tpl("LLC", "Lying Leg Curl (Machine)", "hamstrings"),
    ];
    const h = normalizeHistory(
      [
        workout("2026-06-10", [{ id: "SLP", title: "Seated Leg Press (Machine)", sets: [set(200, 10)] }]),
        workout("2026-06-12", [{ id: "LLC", title: "Lying Leg Curl (Machine)", sets: [set(50, 10)] }]),
      ],
      templates,
      { windowDays: 120, now: NOW },
    );
    const prog = miniProgram([{ name: "Seated Leg Curl", muscle: "Hamstrings", basis: "work", value: 45 }]);
    const m = matchProgramToHistory(prog, h).find((x) => x.exerciseName === "Seated Leg Curl");
    // Leg Press lacks "curl" (hard require) → only the (lying) curl is eligible.
    expect(m?.templateTitle).toBe("Lying Leg Curl (Machine)");
  });

  it("matches an unqualified 'Calf Raise (Machine)' to a stance-specified program slot", () => {
    const h = normalizeHistory(
      [workout("2026-06-10", [{ id: "CR", title: "Calf Raise (Machine)", sets: [set(120, 12), set(120, 11)] }])],
      [tpl("CR", "Calf Raise (Machine)", "calves")],
      { windowDays: 120, now: NOW },
    );
    const prog = miniProgram([{ name: "Standing Calf Raise", muscle: "Calves", basis: "work", value: 90 }]);
    const m = matchProgramToHistory(prog, h).find((x) => x.exerciseName === "Standing Calf Raise");
    expect(m?.templateTitle).toBe("Calf Raise (Machine)");
  });

  it("flags a cross-equipment match and caps its confidence so it is not auto-applied", () => {
    // Program wants a BARBELL incline; only a DUMBBELL incline is in the history.
    const h = normalizeHistory(
      [
        workout("2026-06-05", [{ id: "IND", title: "Incline Bench Press (Dumbbell)", sets: [set(30, 8, 8)] }]),
        workout("2026-06-12", [{ id: "IND", title: "Incline Bench Press (Dumbbell)", sets: [set(32.5, 8, 8)] }]),
        workout("2026-06-19", [{ id: "IND", title: "Incline Bench Press (Dumbbell)", sets: [set(32.5, 8, 8)] }]),
      ],
      [tpl("IND", "Incline Bench Press (Dumbbell)", "chest")],
      { windowDays: 120, now: NOW },
    );
    // seed-style barbell incline slot (alias "incline bench press" → equipment barbell)
    const prog = miniProgram([{ name: "Incline Bench Press", muscle: "Chest", basis: "work", value: 55, compound: true }]);
    const matches = matchProgramToHistory(prog, h);
    const m = matches.find((x) => x.exerciseName === "Incline Bench Press")!;
    expect(m.equipmentMismatch).toBe(true);

    const report = calibrate(prog, h, matches, { now: NOW });
    const cal = report.exercises[0];
    expect(cal.confidence).toBe("low"); // capped — would otherwise be high/medium
    // low confidence is NOT auto-applied at the default minConfidence
    const { changes } = applyCalibration(prog, report);
    expect(changes.find((c) => c.exerciseName === "Incline Bench Press")).toBeUndefined();
  });

  it("normalizeHistory reports windowDays=null when no cutoff was actually applied", () => {
    const h = normalizeHistory(richWorkouts(), ALL_TEMPLATES, { windowDays: 120 }); // no `now`
    expect(h.windowDays).toBeNull();
  });
});

/* ------------------------------------------------------------------ helpers */

interface MiniEx {
  name: string;
  muscle: Program["days"][number]["exercises"][number]["muscle"];
  basis: "max" | "work";
  value: number;
  compound?: boolean;
  rule?: Program["days"][number]["exercises"][number]["rule"];
}

function miniProgram(exercises: MiniEx[]): Program {
  return {
    id: "mini",
    name: "Mini",
    locked: false,
    cycle: { weeksOn: 6, weeksOff: 1, mesocycles: 1, unit: "kg", rounding: { increment: 2.5, mode: "nearest" } },
    days: [
      {
        id: "d1",
        name: "Day 1",
        exercises: exercises.map((e, i) => ({
          id: `ex-${i}`,
          name: e.name,
          muscle: e.muscle,
          compound: e.compound ?? false,
          usesOpeningSingle: false,
          openingSingleRpe: 8,
          loadBasis: e.basis,
          e1rm: e.basis === "max" ? e.value : undefined,
          workWeight: e.basis === "work" ? e.value : undefined,
          rule: e.rule ?? (e.basis === "max" ? "set-threshold-rir" : "double-progression"),
          wave: {
            goal: "strength", shape: "flat", waveLength: 3,
            repsStart: 5, repsEnd: 5, setsStart: 3, setsEnd: 3,
            rirStart: 2, rirEnd: 2, intensityStart: 1, intensityEnd: 1,
          },
          rounding: { increment: 2.5, mode: "nearest" },
        })),
      },
    ],
  };
}
