/**
 * Export a program week to Hevy as routines (the mirror of the import).
 *
 * Takes one week of the program, resolves each exercise to a Hevy exercise
 * template (reusing the matcher against the full catalog; creating a custom
 * template only when nothing matches), turns the engine's prescriptions into
 * routine sets, and creates a folder + one routine per training day.
 *
 * A `dryRun` builds and returns the full plan WITHOUT writing anything, so the
 * exact routines (and any custom exercises that would be created) can be reviewed
 * before they touch the Hevy account.
 *
 * Hevy expects `weight_kg`; the default lb programs are converted at the
 * API boundary. Accessory rep brackets become a Hevy `rep_range`.
 */
import type { MuscleGroup, Program, WeightUnit } from "../../engine/types";
import { dayWeekView } from "../../engine";
import type { HevyClient } from "./client";
import type { HevyExerciseTemplate } from "./types";
import { hevyMuscleToGroup } from "./normalize";
import type { ExerciseHistory, NormalizedHistory } from "./normalize";
import { matchProgramToHistory } from "./match";

const KG_PER_LB = 0.45359237;
function toKg(weight: number, unit: WeightUnit): number {
  return unit === "kg" ? weight : Math.round(weight * KG_PER_LB * 100) / 100;
}

/** Our engine MuscleGroup → Hevy's muscle slug (for creating custom exercises). */
const MUSCLE_TO_HEVY: Record<MuscleGroup, string> = {
  Quadriceps: "quadriceps",
  Hamstrings: "hamstrings",
  Glutes: "glutes",
  Chest: "chest",
  Back: "lats",
  Shoulders: "shoulders",
  Biceps: "biceps",
  Triceps: "triceps",
  Calves: "calves",
  Abs: "abdominals",
  Forearms: "forearms",
};

/** Light equipment guess from an exercise name, mapped to Hevy's enum. */
function equipmentFor(name: string): string {
  const n = name.toLowerCase();
  if (/\bbarbell\b/.test(n)) return "barbell";
  if (/\bdumbbell|db\b/.test(n)) return "dumbbell";
  if (/\bmachine|cable|pulldown|pushdown|press\b/.test(n)) return "machine";
  if (/\bkettlebell\b/.test(n)) return "kettlebell";
  return "other";
}

/** Build a synthetic history from the catalog so the matcher can run against it. */
export function catalogAsHistory(catalog: HevyExerciseTemplate[]): NormalizedHistory {
  const byTemplate = new Map<string, ExerciseHistory>();
  for (const t of catalog) {
    byTemplate.set(t.id, {
      templateId: t.id,
      title: t.title,
      hevyType: t.type,
      primaryMuscle: t.primary_muscle_group,
      muscle: hevyMuscleToGroup(t.primary_muscle_group),
      isCustom: t.is_custom,
      sessions: 0,
      firstDate: "",
      lastDate: "",
      workingSets: [],
      perSession: [],
    });
  }
  return { byTemplate, windowDays: null, workoutsConsidered: 0, dateRange: null };
}

export interface ResolvedTemplate {
  exerciseId: string;
  exerciseName: string;
  muscle: MuscleGroup;
  templateId: string | null;
  templateTitle: string | null;
  score: number;
  source: "matched" | "custom" | "unresolved";
}

/** Resolve every program exercise to a catalog template id (no writes). */
export function resolveTemplates(program: Program, catalog: HevyExerciseTemplate[]): ResolvedTemplate[] {
  const history = catalogAsHistory(catalog);
  const matches = matchProgramToHistory(program, history);
  const byId = new Map(matches.map((m) => [m.exerciseId, m]));
  const out: ResolvedTemplate[] = [];
  const seen = new Set<string>();
  for (const day of program.days) {
    for (const ex of day.exercises) {
      if (seen.has(ex.id)) continue;
      seen.add(ex.id);
      const m = byId.get(ex.id);
      out.push({
        exerciseId: ex.id,
        exerciseName: ex.name,
        muscle: ex.muscle,
        templateId: m?.templateId ?? null,
        templateTitle: m?.templateTitle ?? null,
        score: m?.score ?? 0,
        source: m?.templateId ? "matched" : "unresolved",
      });
    }
  }
  return out;
}

export interface RoutineSetPlan {
  type: "warmup" | "normal" | "dropset";
  weight_kg: number | null;
  reps: number | null;
  rep_range?: { start: number; end: number };
}

/**
 * Note for the program's arms dropset finishers (the `drop-set`-rule lifts the
 * program appends to guarantee every day hits biceps + triceps).
 */
const FINISHER_NOTE =
  "Quick arms finisher — even on a short day, get these 2 dropsets in. Take each set to failure (RPE ~10), drop the weight ~30%, and rep out again.";

/** Routine-level note (the Hevy API rejects an empty routine.notes on update). */
const ROUTINE_NOTE =
  "Warm-up sets are marked and do not count as working volume. Keep them fast and easy. Log honest RPE on the main lifts so next week adapts.";
export interface RoutineExercisePlan {
  exercise_template_id: string;
  superset_id: null;
  rest_seconds: number;
  notes: string;
  sets: RoutineSetPlan[];
  /** Display-only context (not sent to Hevy). */
  _label: string;
}
export interface RoutinePlan {
  title: string;
  folder_id: number | null;
  notes: string;
  exercises: RoutineExercisePlan[];
}

export interface ExportOptions {
  week?: number;
  folderTitle?: string;
  titlePrefix?: string;
  /** dayId → label suffix (e.g. a date) appended to the routine title. */
  dayLabels?: Record<string, string>;
  restCompound?: number;
  restAccessory?: number;
  dryRun?: boolean;
  /** Create a custom Hevy exercise when a program lift has no catalog match. */
  createCustom?: boolean;
  /** "create" makes new routines; "update" PUTs onto the existing ones in the folder. */
  mode?: "create" | "update";
  /** Only export these training days (default: every day in the program). */
  dayIds?: string[];
}

function buildRoutine(
  program: Program,
  dayId: string,
  week: number,
  idMap: Map<string, string>,
  o: Required<Pick<ExportOptions, "restCompound" | "restAccessory">>,
  title: string,
  folderId: number | null,
): RoutinePlan {
  const unit = program.cycle.unit;
  const exercises: RoutineExercisePlan[] = [];
  for (const v of dayWeekView(program, dayId, week)) {
    const tid = idMap.get(v.exercise.id);
    if (!tid) continue; // unresolved — skipped (surfaced separately)
    const e = v.exercise;
    const p = v.prescription;
    // The program owns the full-body arms finisher: a `drop-set`-rule lift exports
    // as Hevy dropset sets (the rule IS the dropset).
    const isDropset = e.rule === "drop-set";
    const bodyweight = e.loadBasis === "work" && (e.workWeight ?? 0) === 0 && p.load === 0;
    const weightKg = bodyweight ? null : toKg(p.load, unit);
    // Accessories with a rep cap carry a Hevy rep_range (reps null); fixed-rep
    // strength/calibration/dropset sets carry a single reps value. Never both —
    // the API treats them as alternatives.
    const hasRange = !isDropset && e.repCap != null && e.repCap > p.reps;
    const set: RoutineSetPlan = {
      type: isDropset ? "dropset" : "normal",
      weight_kg: weightKg,
      reps: hasRange ? null : p.reps,
      ...(hasRange ? { rep_range: { start: p.reps, end: e.repCap as number } } : {}),
    };
    // Hevy routine sets carry no RPE field, so the target RPE goes in the note.
    // RPE = 10 − RIR; the prescription's rirCutoff is the reps-in-reserve target.
    const targetRpe = Math.round((10 - p.rirCutoff) * 10) / 10;
    const warmupText = p.warmupSets.length
      ? `Warm-up (marked): ${p.warmupSets.map((s) => `${s.load}${unit}×${s.reps}`).join(" → ")}. Keep every rep fast; these do not count as work sets. `
      : "";
    let note: string;
    if (isDropset) {
      note = FINISHER_NOTE;
    } else if (p.openingSingle) {
      note = `${warmupText}Then take the opening single @RPE ${p.openingSingle.rpe} (~${p.openingSingle.weight}${unit}), followed by work sets at RPE ${targetRpe} (~${p.rirCutoff} reps in reserve).`;
    } else if (e.loadBasis === "max") {
      note = `${warmupText}Calibration work sets — target RPE ${targetRpe} (~${p.rirCutoff} reps in reserve). Log your HONEST RPE; the plan back-computes your 1RM from it.`;
    } else {
      note = `${warmupText}Work sets: target RPE ${targetRpe} — stop each set with ~${p.rirCutoff} reps in reserve.`;
    }
    const warmupSets: RoutineSetPlan[] = p.warmupSets.map((warmup) => ({
      type: "warmup",
      weight_kg: toKg(warmup.load, unit),
      reps: warmup.reps,
    }));
    exercises.push({
      exercise_template_id: tid,
      superset_id: null,
      rest_seconds: isDropset ? 60 : e.compound ? o.restCompound : o.restAccessory,
      notes: note,
      sets: [...warmupSets, ...Array.from({ length: p.sets }, () => ({ ...set }))],
      _label: `${e.name} — ${p.warmupSets.length ? `warm-up ${p.warmupSets.map((s) => `${s.load}×${s.reps}`).join(", ")} → ` : ""}${bodyweight ? "BW" : `${p.load}${unit}`} × ${p.reps}${hasRange ? `-${e.repCap}` : ""} × ${p.sets}${isDropset ? " (dropset)" : ""}`,
    });
  }
  return { title, folder_id: folderId, notes: ROUTINE_NOTE, exercises };
}

export interface ExportResult {
  dryRun: boolean;
  mode: "create" | "update";
  week: number;
  folderTitle: string;
  folderId: number | null;
  resolved: ResolvedTemplate[];
  unresolved: string[];
  customsCreated: { name: string; id: string }[];
  routines: RoutinePlan[];
  created: { title: string; id?: string }[];
  updated: { title: string; id: string }[];
}

/**
 * Resolve templates, (optionally) create customs, then create OR update one
 * routine per training day for `week`. The program's `drop-set`-rule arms
 * finishers export as dropset sets. With `dryRun`, builds and returns the full
 * plan without any writes.
 */
export async function exportWeekToHevy(
  client: HevyClient,
  program: Program,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const week = opts.week ?? 1;
  const dryRun = opts.dryRun ?? false;
  const mode = opts.mode ?? "create";
  const createCustom = opts.createCustom ?? true;
  const folderTitle = opts.folderTitle ?? `${program.name} · week ${week}`;
  const rest = { restCompound: opts.restCompound ?? 180, restAccessory: opts.restAccessory ?? 90 };

  // Days actually being pushed (dayIds narrows the export to a subset).
  const pushedDays = program.days.filter((d) => !opts.dayIds || opts.dayIds.includes(d.id));
  const neededExerciseIds = new Set(pushedDays.flatMap((d) => d.exercises.map((e) => e.id)));

  const catalog = await client.getAllTemplates();
  const resolved = resolveTemplates(program, catalog);

  // Build the exercise-id → template-id map, creating customs for misses.
  // Customs are only created for lifts that are actually being pushed.
  const idMap = new Map<string, string>();
  const customsCreated: { name: string; id: string }[] = [];
  const unresolved: string[] = [];
  for (const r of resolved) {
    if (r.templateId) {
      idMap.set(r.exerciseId, r.templateId);
      continue;
    }
    if (!neededExerciseIds.has(r.exerciseId)) continue;
    if (!createCustom) {
      unresolved.push(r.exerciseName);
      continue;
    }
    if (dryRun) {
      r.source = "custom"; // would be created
      unresolved.push(r.exerciseName);
      continue;
    }
    const exDef = program.days.flatMap((d) => d.exercises).find((e) => e.id === r.exerciseId)!;
    const bodyweight = exDef.loadBasis === "work" && (exDef.workWeight ?? 0) === 0;
    const { id } = await client.createExerciseTemplate({
      title: r.exerciseName,
      exercise_type: bodyweight ? "bodyweight_reps" : "weight_reps",
      equipment_category: equipmentFor(r.exerciseName),
      muscle_group: MUSCLE_TO_HEVY[r.muscle] ?? "other",
      other_muscles: [],
    });
    if (id) {
      idMap.set(r.exerciseId, id);
      r.templateId = id;
      r.source = "custom";
      customsCreated.push({ name: r.exerciseName, id });
    } else {
      unresolved.push(r.exerciseName);
    }
  }

  // In update mode, find the already-pushed routines so we PUT onto them.
  const existing = !dryRun && mode === "update" ? await client.getAllRoutines() : [];
  // Each routine title carries a stable, collision-free marker `[<day.id>]`. Note
  // "[day-1]" is NOT a substring of "[ramp-day-1]" (the bracket is a boundary), so
  // a main-block update can never grab a leftover ramp routine, and vice-versa.
  const DAY_MARKER = /\[[a-z0-9-]*day-?\d*\]/i;
  const anyMarkered = existing.some((r) => DAY_MARKER.test(r.title));

  // Folder (create mode only — PUT can't move folders, so update reuses them).
  let folderId: number | null = null;
  if (!dryRun && mode === "create") {
    const folder = await client.createRoutineFolder(folderTitle);
    folderId = folder.id;
  }

  // One routine per day.
  const routines: RoutinePlan[] = [];
  const created: { title: string; id?: string }[] = [];
  const updated: { title: string; id: string }[] = [];
  for (const day of pushedDays) {
    const marker = `[${day.id}]`;
    const suffix = opts.dayLabels?.[day.id] ? ` (${opts.dayLabels[day.id]})` : "";
    const title = `${opts.titlePrefix ? opts.titlePrefix + " " : ""}${day.name}${suffix} ${marker}`;
    const plan = buildRoutine(program, day.id, week, idMap, rest, title, folderId);
    routines.push(plan);
    if (dryRun || plan.exercises.length === 0) continue;

    const payload = {
      title: plan.title,
      ...(mode === "create" ? { folder_id: plan.folder_id } : {}),
      notes: plan.notes,
      exercises: plan.exercises.map(({ _label, ...e }) => e),
    };
    if (mode === "update") {
      // Prefer the exact marker; require a single match (never guess).
      const byMarker = existing.filter((r) => r.title.includes(marker));
      let match = byMarker.length === 1 ? byMarker[0] : undefined;
      if (byMarker.length > 1) {
        unresolved.push(`${day.name}: ${byMarker.length} routines match ${marker} — skipped (resolve duplicates in Hevy)`);
        continue;
      }
      // One-time migration: legacy routines have no marker, match by day name.
      if (!match && !anyMarkered) match = existing.find((r) => r.title.includes(day.name));
      if (match) {
        const res = await client.updateRoutine(match.id, payload);
        updated.push({ title: plan.title, id: res.id ?? match.id });
        continue;
      }
      unresolved.push(`${day.name}: no existing routine matched ${marker} — created a fresh one`);
    }
    const res = await client.createRoutine(payload);
    created.push({ title: plan.title, id: res.id });
  }

  return {
    dryRun, mode, week, folderTitle, folderId, resolved, unresolved,
    customsCreated, routines, created, updated,
  };
}
