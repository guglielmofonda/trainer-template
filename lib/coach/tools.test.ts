import { describe, expect, it } from "vitest";
import { runCoachTool, describeToolCall, summarizeOutcome, MUTATING_TOOLS, COACH_TOOL_DEFINITIONS } from "./tools";
import { fakeHevy, fixtureProgram, fixtureState, fixtureWorkouts, lbToKg, makeCtx, MemStore } from "./testFixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

async function ok(name: string, input: unknown, ctx: Parameters<typeof runCoachTool>[2]): Promise<Any> {
  const out = await runCoachTool(name, input, ctx);
  expect(out.isError, `expected ${name} to succeed, got: ${JSON.stringify(out.result)}`).toBe(false);
  return out.result as Any;
}

async function fail(name: string, input: unknown, ctx: Parameters<typeof runCoachTool>[2]): Promise<string> {
  const out = await runCoachTool(name, input, ctx);
  expect(out.isError, `expected ${name} to fail, got: ${JSON.stringify(out.result)}`).toBe(true);
  return (out.result as { error: string }).error;
}

describe("tool definitions", () => {
  it("every definition has a matching executor and valid JSON schema shell", () => {
    for (const def of COACH_TOOL_DEFINITIONS) {
      expect(def.name).toBeTruthy();
      expect(def.description.length).toBeGreaterThan(40);
      expect((def.input_schema as Any).type).toBe("object");
    }
    // No duplicate names.
    const names = COACH_TOOL_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    // Mutating set only contains real tools.
    for (const name of MUTATING_TOOLS) expect(names).toContain(name);
  });

  it("rejects unknown tools gracefully", async () => {
    const { ctx } = makeCtx();
    const msg = await fail("explode", {}, ctx);
    expect(msg).toContain("Unknown tool");
  });
});

describe("get_schedule", () => {
  it("anchors date math: today is Saturday, tomorrow Sunday, then Monday", async () => {
    const { ctx } = makeCtx();
    const r = await ok("get_schedule", {}, ctx);
    expect(r.today).toEqual({ date: "2026-07-11", weekday: "Saturday", timezone: "UTC" });
    expect(r.next14Days[0]).toEqual({ date: "2026-07-12", weekday: "Sunday", isDefaultTrainingDay: false });
    expect(r.next14Days[1]).toEqual({ date: "2026-07-13", weekday: "Monday", isDefaultTrainingDay: true });
    expect(r.defaultTrainingWeekdays).toEqual(["Monday", "Thursday", "Saturday"]);
  });

  it("reports block state, day ids, and what was already logged this week", async () => {
    const { ctx } = makeCtx();
    const r = await ok("get_schedule", {}, ctx);
    expect(r.block).toMatchObject({ block: "main", currentWeek: 2, totalWeeks: 4, isDeload: false });
    expect(r.program.days.map((d: Any) => d.id)).toEqual(["day-a", "day-b"]);
    // Only the week-2 log shows up (the week-1 row log is filtered out).
    expect(r.loggedThisWeek).toEqual([{ date: "2026-07-06", dayId: "day-a", dayName: "Full Body A" }]);
  });

  it("clamps a stale block week to the calendar length", async () => {
    const { ctx } = makeCtx({ state: fixtureState({ currentWeek: 99 }) });
    const r = await ok("get_schedule", {}, ctx);
    expect(r.block.currentWeek).toBe(4);
    expect(r.block.isDeload).toBe(true);
  });
});

describe("read tools", () => {
  it("get_program exposes ids and full wave configs for editing", async () => {
    const { ctx } = makeCtx();
    const r = await ok("get_program", {}, ctx);
    expect(r.locked).toBe(false);
    expect(r.cycle.totalWeeks).toBe(4);
    const squat = r.days[0].exercises[0];
    expect(squat).toMatchObject({ id: "squat-1", loadBasis: "max", e1rm: 300, rule: "calibration" });
    expect(squat.wave).toMatchObject({ repsStart: 5, setsStart: 3, rirStart: 2 });
  });

  it("get_day_prescriptions returns concrete loads, warm-ups, and rep ranges", async () => {
    const { ctx } = makeCtx();
    const r = await ok("get_day_prescriptions", { dayId: "day-a" }, ctx);
    expect(r).toMatchObject({ dayId: "day-a", week: 2, unit: "lb", isDeload: false });
    const [squat, row, curl] = r.exercises;
    expect(squat.name).toBe("Back Squat");
    expect(squat.load).toBeGreaterThan(100);
    expect(squat.warmupSets.length).toBeGreaterThan(0);
    expect(squat.targetRpe).toBe(8); // 2 RIR
    expect(row).toMatchObject({ load: 100, reps: 10, repRangeTop: 15, sets: 3 });
    expect(curl.isDropsetFinisher).toBe(true);
  });

  it("get_day_prescriptions rejects unknown days and lists valid ids", async () => {
    const { ctx } = makeCtx();
    const msg = await fail("get_day_prescriptions", { dayId: "nope" }, ctx);
    expect(msg).toContain("day-a");
    expect(msg).toContain("day-b");
  });

  it("get_week_volume totals working sets per muscle with verdicts", async () => {
    const { ctx } = makeCtx();
    const r = await ok("get_week_volume", {}, ctx);
    expect(r.week).toBe(2);
    expect(r.totalSets).toBe(16); // 3+3+2 + 3+3+2
    const quads = r.byMuscle.find((m: Any) => m.muscle === "Quadriceps");
    expect(quads.sets).toBe(3);
    expect(["under", "maintenance", "productive", "high", "over"]).toContain(quads.verdict);
  });

  it("get_recent_logs sorts newest-first and filters by exercise", async () => {
    const { ctx } = makeCtx();
    const all = await ok("get_recent_logs", {}, ctx);
    expect(all.logs.map((l: Any) => l.exercise)).toEqual(["Back Squat", "Chest Supported Row"]);
    const filtered = await ok("get_recent_logs", { exercise: "row" }, ctx);
    expect(filtered.logs).toHaveLength(1);
    expect(filtered.logs[0].decision).toContain("Double progression");
    const limited = await ok("get_recent_logs", { limit: 1 }, ctx);
    expect(limited.logs).toHaveLength(1);
  });

  it("get_progression_rules covers the rules in use plus the full catalog", async () => {
    const { ctx } = makeCtx();
    const r = await ok("get_progression_rules", {}, ctx);
    const ids = r.rulesInUse.map((x: Any) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["calibration", "double-progression", "drop-set", "linear"]));
    expect(r.allRules.length).toBeGreaterThanOrEqual(11);
  });
});

describe("Hevy read tools", () => {
  it("get_hevy_workouts converts kg to the program unit and matches day markers", async () => {
    const { ctx } = makeCtx({ hevy: fakeHevy({ workouts: fixtureWorkouts() }) });
    const r = await ok("get_hevy_workouts", { days: 14 }, ctx);
    expect(r.unit).toBe("lb");
    expect(r.workouts).toHaveLength(1); // the May session is outside the window
    const [w] = r.workouts;
    expect(w).toMatchObject({ date: "2026-07-09", weekday: "Thursday", matchedDayId: "day-b" });
    const bench = w.exercises[0];
    expect(bench.name).toBe("Bench Press (Barbell)");
    expect(bench.sets[0]).toMatchObject({ type: "warmup", weight: 135, reps: 5 });
    expect(bench.sets[1]).toMatchObject({ type: "normal", weight: 200, reps: 5, rpe: 8 });
  });

  it("list_hevy_routines maps routine titles back to program days", async () => {
    const { ctx } = makeCtx({
      hevy: fakeHevy({
        routines: [
          { id: "ra", title: "W1 Full Body A [day-a]", folder_id: 1 },
          { id: "rb", title: "W1 Full Body B [day-b]", folder_id: 1 },
          { id: "rx", title: "Random routine", folder_id: null },
        ],
      }),
    });
    const r = await ok("list_hevy_routines", {}, ctx);
    expect(r.routines).toHaveLength(3);
    expect(r.routines.find((x: Any) => x.id === "ra").matchedDayId).toBe("day-a");
    expect(r.routines.find((x: Any) => x.id === "rx").matchedDayId).toBeNull();
  });

  it("get_progress_snapshot returns lift e1RM trends and bodyweight", async () => {
    const { ctx } = makeCtx({
      hevy: fakeHevy({
        workouts: fixtureWorkouts(),
        measurements: [
          { date: "2026-07-01", weight_kg: 84 },
          { date: "2026-06-01", weight_kg: 86 },
        ],
      }),
    });
    const r = await ok("get_progress_snapshot", {}, ctx);
    const bench = r.lifts.find((l: Any) => l.lift === "Bench press");
    expect(bench.latestE1rmLb).toBeGreaterThan(200);
    expect(bench.recentPoints.length).toBeGreaterThan(0);
    expect(r.bodyWeight.latestLb).toBeCloseTo(185.2, 0);
  });

  it("keeps integration setup server-owned when Hevy is unavailable", async () => {
    const { ctx } = makeCtx({ hevy: null });
    for (const tool of ["get_hevy_workouts", "list_hevy_routines", "get_progress_snapshot", "push_to_hevy"]) {
      const msg = await fail(tool, {}, ctx);
      expect(msg).toContain("server-side Hevy connection");
      expect(msg).not.toContain("API key");
    }
  });
});

describe("update_program", () => {
  it("updates anchors and flattens sets/reps/rir shorthands into the wave", async () => {
    const { ctx, store } = makeCtx();
    const r = await ok(
      "update_program",
      {
        edits: [
          { op: "update_exercise", exerciseId: "squat-1", set: { e1rm: 310, sets: 4, rir: 3 } },
          { op: "update_exercise", exerciseId: "row-2", set: { workWeight: 105 } },
        ],
      },
      ctx,
    );
    expect(r.applied).toHaveLength(2);
    expect(r.applied[0]).toContain("e1rm 300→310");
    const squat = store.program.days[0].exercises[0];
    expect(squat.e1rm).toBe(310);
    expect(squat.wave.setsStart).toBe(4);
    expect(squat.wave.setsEnd).toBe(4);
    expect(squat.wave.rirStart).toBe(3);
    expect(store.program.days[0].exercises[1].workWeight).toBe(105);
    // Result carries the recomputed day snapshot + volume so the model can verify.
    expect(r.days[0].exercises[0].line).toMatch(/× 4 sets/);
    expect(r.volume.totalSets).toBe(17);
    expect(r.reminder).toContain("push_to_hevy");
  });

  it("supports fine-grained wave edits without flattening", async () => {
    const { ctx, store } = makeCtx();
    await ok(
      "update_program",
      { edits: [{ op: "update_exercise", exerciseId: "bench-4", set: { wave: { repsStart: 8, repsEnd: 5, shape: "descending-wave" } } }] },
      ctx,
    );
    const bench = store.program.days[1].exercises[0];
    expect(bench.wave).toMatchObject({ repsStart: 8, repsEnd: 5, shape: "descending-wave" });
  });

  it("guards the load basis: e1rm on a work-basis lift is rejected", async () => {
    const { ctx, store } = makeCtx();
    const msg = await fail(
      "update_program",
      { edits: [{ op: "update_exercise", exerciseId: "row-2", set: { e1rm: 200 } }] },
      ctx,
    );
    expect(msg).toContain("workWeight");
    expect(store.program.days[0].exercises[1].workWeight).toBe(100);
  });

  it("is atomic: one invalid edit rolls back the whole batch", async () => {
    const { ctx, store } = makeCtx();
    const msg = await fail(
      "update_program",
      {
        edits: [
          { op: "update_exercise", exerciseId: "squat-1", set: { e1rm: 500 } },
          { op: "update_exercise", exerciseId: "ghost-99", set: { e1rm: 100 } },
        ],
      },
      ctx,
    );
    expect(msg).toContain("ghost-99");
    expect(store.program.days[0].exercises[0].e1rm).toBe(300); // first edit rolled back
  });

  it("respects the program lock and points at set_program_lock", async () => {
    const store = new MemStore({ ...fixtureProgram(), locked: true });
    const { ctx } = makeCtx({ store });
    const msg = await fail(
      "update_program",
      { edits: [{ op: "update_exercise", exerciseId: "squat-1", set: { e1rm: 310 } }] },
      ctx,
    );
    expect(msg).toContain("locked");
    expect(msg).toContain("set_program_lock");
    expect(store.program.days[0].exercises[0].e1rm).toBe(300);

    await ok("set_program_lock", { locked: false }, ctx);
    await ok("update_program", { edits: [{ op: "update_exercise", exerciseId: "squat-1", set: { e1rm: 310 } }] }, ctx);
    expect(store.program.days[0].exercises[0].e1rm).toBe(310);
    await ok("set_program_lock", { locked: true }, ctx);
    expect(store.program.locked).toBe(true);
  });

  it("adds exercises with generated ids and sensible defaults", async () => {
    const { ctx, store } = makeCtx();
    const r = await ok(
      "update_program",
      {
        edits: [
          {
            op: "add_exercise",
            dayId: "day-a",
            position: 1,
            exercise: { name: "Leg Press", muscle: "Quadriceps", loadBasis: "work", workWeight: 200, sets: 3, reps: 10 },
          },
        ],
      },
      ctx,
    );
    expect(r.applied[0]).toContain("Leg Press");
    const added = store.program.days[0].exercises[1];
    expect(added.id).toBe("leg-press-1");
    expect(added.rule).toBe("double-progression"); // work-basis default
    expect(added.repCap).toBe(13); // reps + 3 default for double progression
    expect(added.wave.setsStart).toBe(3);
    expect(added.rounding).toEqual(store.program.cycle.rounding);
  });

  it("validates add_exercise basis requirements via zod", async () => {
    const { ctx } = makeCtx();
    const msg = await fail(
      "update_program",
      { edits: [{ op: "add_exercise", dayId: "day-a", exercise: { name: "Dip", muscle: "Chest", loadBasis: "work", sets: 3, reps: 8 } }] },
      ctx,
    );
    expect(msg).toContain("workWeight");
  });

  it("moves, removes, renames, reorders", async () => {
    const { ctx, store } = makeCtx();
    await ok(
      "update_program",
      {
        edits: [
          { op: "move_exercise", exerciseId: "pushdown-6", toDayId: "day-a", position: 1 },
          { op: "remove_exercise", exerciseId: "curl-3" },
          { op: "rename_day", dayId: "day-b", name: "Pull Emphasis" },
          { op: "reorder_days", dayIds: ["day-b", "day-a"] },
        ],
      },
      ctx,
    );
    expect(store.program.days.map((d) => d.id)).toEqual(["day-b", "day-a"]);
    expect(store.program.days[0].name).toBe("Pull Emphasis");
    const dayA = store.program.days[1];
    expect(dayA.exercises.map((e) => e.id)).toEqual(["squat-1", "pushdown-6", "row-2"]);
  });

  it("rejects a reorder that is not a permutation of existing days", async () => {
    const { ctx } = makeCtx();
    const msg = await fail("update_program", { edits: [{ op: "reorder_days", dayIds: ["day-a"] }] }, ctx);
    expect(msg).toContain("every existing day id");
  });

  it("adds and removes whole days, but never all of them", async () => {
    const { ctx, store } = makeCtx();
    const r = await ok(
      "update_program",
      { edits: [{ op: "add_day", name: "Day C" }, { op: "remove_day", dayId: "day-b" }] },
      ctx,
    );
    expect(store.program.days.map((d) => d.id)).toEqual(["day-a", "day-c-1"]);
    expect(r.warnings?.[0]).toContain("Day C"); // flagged as empty
    const msg = await fail(
      "update_program",
      { edits: [{ op: "remove_day", dayId: "day-a" }, { op: "remove_day", dayId: "day-c-1" }] },
      ctx,
    );
    expect(msg).toContain("zero training days");
    expect(store.program.days).toHaveLength(2);
  });

  it("rejects an empty update set", async () => {
    const { ctx } = makeCtx();
    const msg = await fail("update_program", { edits: [{ op: "update_exercise", exerciseId: "squat-1", set: {} }] }, ctx);
    expect(msg).toContain("no changes");
  });
});

describe("log_session", () => {
  it("appends a log and returns the engine's decision + next preview", async () => {
    const { ctx, store } = makeCtx();
    const r = await ok(
      "log_session",
      {
        dayId: "day-a",
        exerciseId: "row-2",
        sets: [
          { weight: 100, reps: 15, rpe: 8 },
          { weight: 100, reps: 14, rpe: 8.5 },
          { weight: 100, reps: 13, rpe: 9 },
        ],
      },
      ctx,
    );
    expect(r.logged).toMatchObject({ exercise: "Chest Supported Row", week: 2, date: "2026-07-11", sets: 3 });
    expect(typeof r.decision).toBe("string");
    expect(r.decision.length).toBeGreaterThan(5);
    expect(r.nextSessionPreview).toMatchObject({ unit: "lb" });
    expect(r.nextSessionPreview.load).toBeGreaterThan(0);
    expect(store.logs).toHaveLength(3);
    expect(store.logs[2].decisionNote).toBe(r.decision);
  });

  it("rejects an exercise that is not on the given day", async () => {
    const { ctx, store } = makeCtx();
    const msg = await fail(
      "log_session",
      { dayId: "day-b", exerciseId: "squat-1", sets: [{ weight: 100, reps: 5, rpe: 8 }] },
      ctx,
    );
    expect(msg).toContain("bench-4");
    expect(store.logs).toHaveLength(2);
  });

  it("validates set shapes via zod", async () => {
    const { ctx } = makeCtx();
    const msg = await fail("log_session", { dayId: "day-a", exerciseId: "squat-1", sets: [] }, ctx);
    expect(msg).toContain("sets");
  });
});

describe("push_to_hevy", () => {
  it("defaults to a dry run: full routine plan, ZERO writes", async () => {
    const hevy = fakeHevy();
    const { ctx } = makeCtx({ hevy });
    const r = await ok(
      "push_to_hevy",
      { dayIds: ["day-a", "day-b"], datesByDayId: { "day-a": "2026-07-12", "day-b": "2026-07-13" } },
      ctx,
    );
    expect(r.dryRun).toBe(true);
    expect(r.week).toBe(2);
    expect(r.routines.map((x: Any) => x.title)).toEqual([
      "W2 Full Body A (Sun 07-12) [day-a]",
      "W2 Full Body B (Mon 07-13) [day-b]",
    ]);
    expect(r.routines[0].exercises.length).toBe(3);
    expect(r.note).toContain("DRY RUN");
    expect(hevy.writes()).toHaveLength(0); // nothing written
    expect(r.templateMatching.matched).toBeGreaterThanOrEqual(6);
  });

  it("pushes a subset of days with dayIds", async () => {
    const hevy = fakeHevy();
    const { ctx } = makeCtx({ hevy });
    const r = await ok("push_to_hevy", { dayIds: ["day-a"] }, ctx);
    expect(r.routines).toHaveLength(1);
    expect(r.routines[0].title).toContain("[day-a]");
  });

  it("update mode PUTs onto the existing marker-matched routines with converted loads", async () => {
    const hevy = fakeHevy({
      routines: [
        { id: "ra", title: "W1 Full Body A [day-a]", folder_id: 1 },
        { id: "rb", title: "W1 Full Body B [day-b]", folder_id: 1 },
      ],
    });
    const { ctx } = makeCtx({ hevy });
    const r = await ok(
      "push_to_hevy",
      { push: true, mode: "update", dayIds: ["day-a", "day-b"], datesByDayId: { "day-a": "2026-07-12", "day-b": "2026-07-13" } },
      ctx,
    );
    expect(r.pushed).toBe(true);
    expect(r.written.updated).toHaveLength(2);

    const puts = hevy.writes().filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.path).sort()).toEqual(["/v1/routines/ra", "/v1/routines/rb"]);

    const dayA = (puts.find((c) => c.path.endsWith("/ra"))!.body as Any).routine;
    expect(dayA.title).toBe("W2 Full Body A (Sun 07-12) [day-a]");
    // Squat: marked warm-up ramp first, then working sets in kg.
    const squat = dayA.exercises[0];
    expect(squat.exercise_template_id).toBe("tmpl-squat");
    expect(squat.sets[0].type).toBe("warmup");
    const normals = squat.sets.filter((s: Any) => s.type === "normal");
    expect(normals).toHaveLength(3);
    expect(normals[0].reps).toBe(5);
    // Row: double-progression bracket exports as a Hevy rep_range.
    const row = dayA.exercises[1];
    expect(row.sets[0].rep_range).toEqual({ start: 10, end: 15 });
    expect(row.sets[0].reps).toBeNull();
    expect(row.sets[0].weight_kg).toBeCloseTo(lbToKg(100), 2);
    // Curl finisher: dropset sets.
    const curl = dayA.exercises[2];
    expect(curl.sets.every((s: Any) => s.type === "dropset")).toBe(true);
    // Target RPE is carried in the per-exercise note (Hevy has no RPE field).
    expect(squat.notes).toContain("RPE");
  });

  it("create mode makes a folder and new routines", async () => {
    const hevy = fakeHevy();
    const { ctx } = makeCtx({ hevy });
    const r = await ok("push_to_hevy", { push: true, mode: "create", folderTitle: "Test wk2" }, ctx);
    expect(r.written.created).toHaveLength(2);
    const writes = hevy.writes();
    expect(writes.filter((c) => c.path === "/v1/routine_folders")).toHaveLength(1);
    expect(writes.filter((c) => c.path === "/v1/routines")).toHaveLength(2);
    expect(r.written.folderId).toBeGreaterThan(0);
  });

  it("flags duplicate day markers instead of guessing which routine to overwrite", async () => {
    const hevy = fakeHevy({
      routines: [
        { id: "r1", title: "W1 Full Body A [day-a]", folder_id: 1 },
        { id: "r2", title: "Copy of Full Body A [day-a]", folder_id: 1 },
        { id: "rb", title: "W1 Full Body B [day-b]", folder_id: 1 },
      ],
    });
    const { ctx } = makeCtx({ hevy });
    const r = await ok("push_to_hevy", { push: true, mode: "update" }, ctx);
    expect(r.templateMatching.unresolved.join(" ")).toContain("2 routines match");
    // day-a skipped, day-b still updated
    expect(r.written.updated).toHaveLength(1);
    expect(hevy.writes().filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("validates day ids and date formats before doing anything", async () => {
    const hevy = fakeHevy();
    const { ctx } = makeCtx({ hevy });
    expect(await fail("push_to_hevy", { dayIds: ["ghost"] }, ctx)).toContain("ghost");
    expect(await fail("push_to_hevy", { datesByDayId: { "day-a": "next sunday" } }, ctx)).toContain("YYYY-MM-DD");
    expect(hevy.writes()).toHaveLength(0);
  });
});

describe("UI labels", () => {
  it("describes calls and summarizes outcomes in plain language", async () => {
    expect(describeToolCall("get_schedule", {})).toContain("schedule");
    expect(describeToolCall("push_to_hevy", { push: false, dayIds: ["day-a"] })).toContain("dry run");
    expect(describeToolCall("push_to_hevy", { push: true, dayIds: ["day-a", "day-b"] })).toContain("Pushing 2 days");
    expect(describeToolCall("update_program", { edits: [{}, {}] })).toContain("2 changes");

    const { ctx } = makeCtx();
    const outcome = await runCoachTool("update_program", { edits: [{ op: "update_exercise", exerciseId: "squat-1", set: { e1rm: 305 } }] }, ctx);
    expect(summarizeOutcome("update_program", outcome)).toBe("1 change(s) applied");
    const err = await runCoachTool("get_day_prescriptions", { dayId: "nope" }, ctx);
    expect(summarizeOutcome("get_day_prescriptions", err)).toContain("Unknown dayId");
  });
});
