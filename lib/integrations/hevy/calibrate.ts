/**
 * Calibration — turn the athlete's real history into starting weights and
 * plan-tuning recommendations.
 *
 * PURE. Two jobs:
 *  1. Per exercise: a suggested anchor in the program's unit —
 *     • max-basis lifts (squat/bench/DL/OHP) → an estimated 1RM, computed with
 *       the engine's OWN `estimate1RM` (RPE→%1RM), from a robust "recent best"
 *       (median of the top few e1RM estimates) so one fluke set can't inflate it.
 *     • work-basis accessories → a realistic starting working weight (median of
 *       the recent sessions' top working set).
 *     Each suggestion carries a confidence, the source set(s), and a rationale —
 *     never a black box.
 *  2. Plan-level recommendations: lifts trained hard but absent from the plan,
 *     planned lifts with no history, a volume reality-check vs the program's
 *     MEV/MAV/MRV landmarks, and stale-data / big-change flags.
 *
 * Safety bias: in this engine, a lower RPE means more reps-in-reserve, which
 * implies a HIGHER 1RM — so for a working set logged without RPE the conservative
 * read is to assume it was *near* failure (default RPE 9, ~1 rep in reserve), not
 * far from it. That biases the estimate down, never up. We also drop high-rep sets
 * for 1RM estimation (extrapolation error grows with reps) and use a robust
 * "recent best" (median of the top few single-set estimates), not the single max,
 * so one fluke set can't inflate the number.
 */
import type { LoadBasis, MuscleGroup, Program, WeightUnit } from "../../engine/types";
import { estimate1RM } from "../../engine/e1rm";
import { DEFAULT_ROUNDING_KG, DEFAULT_ROUNDING_LB, roundWeight } from "../../engine/rounding";
import { planningCheck } from "../../engine/analysis";
import { VOLUME_LANDMARKS } from "../../domain/muscles";
import type { ExerciseHistory, NormalizedHistory, WorkingSet } from "./normalize";
import type { ExerciseMatch } from "./match";

export type Confidence = "high" | "medium" | "low" | "none";

export interface E1rmSource {
  weightKg: number;
  reps: number;
  rpe: number | null;
  /** True when RPE wasn't logged and we assumed one (lower trust). */
  assumedRpe: boolean;
  date: string;
  e1rmKg: number;
}

export interface ExerciseCalibration {
  exerciseId: string;
  exerciseName: string;
  muscle: MuscleGroup;
  loadBasis: LoadBasis;
  unit: WeightUnit;
  matchedTitle: string | null;
  matchScore: number;
  confidence: Confidence;
  /** Sessions of the matched lift inside the window. */
  sessions: number;
  /** Current anchor (e1RM for max basis, workWeight for work basis), in `unit`. */
  current: number | null;
  /** Suggested anchor in `unit`. Null when there's no usable data. */
  suggested: number | null;
  /** % change current→suggested (null if either side missing). */
  changePct: number | null;
  /** For max-basis lifts: the single most informative source set. */
  bestSet?: E1rmSource;
  /** Observed working-set rep range (across the window). */
  repRange?: { min: number; median: number; max: number };
  /** Fraction of contributing sets that had a real (logged) RPE, 0..1. */
  usedRpeFraction: number;
  rationale: string;
  notes: string[];
}

export type RecommendationKind =
  | "untracked-lift"
  | "no-history"
  | "volume-reality"
  | "big-change"
  | "stale-data";

export interface Recommendation {
  kind: RecommendationKind;
  severity: "info" | "suggest" | "warn";
  title: string;
  detail: string;
  data?: Record<string, unknown>;
}

export interface CalibrationReport {
  program: string;
  unit: WeightUnit;
  windowDays: number | null;
  now: string | null;
  workoutsConsidered: number;
  dateRange: { from: string; to: string } | null;
  user?: { name?: string };
  exercises: ExerciseCalibration[];
  recommendations: Recommendation[];
}

export interface CalibrateOptions {
  /** Reference "today" (ISO) for staleness checks. Engine stays clock-free. */
  now?: string;
  /** For reporting only — the window normalization already applied. */
  windowDays?: number;
  user?: { name?: string };
  /** Assumed RPE for working sets with no logged RPE. Default 9 (conservative: a
   *  logged top set is treated as ~1 rep from failure, biasing e1RM down not up). */
  assumedRpe?: number;
  /** Ignore sets above this rep count for 1RM estimation. Default 12. */
  e1rmRepCap?: number;
  /** Robust e1RM = median of the top-N single-set estimates. Default 3. */
  topN?: number;
  /** Sessions threshold for "high" confidence. Default 3. */
  minSessionsHigh?: number;
  /** Sessions threshold for "medium" (auto-applied) confidence. Default 2 — a
   *  single session isn't enough to auto-overwrite a starting weight (it's often a
   *  one-off variant), so 1-session matches land at "low" and are shown for review. */
  minSessionsMedium?: number;
  /** How many recent sessions feed the accessory working-weight median. Default 6. */
  recentSessions?: number;
  /** Surface untracked lifts trained at least this many sessions. Default 4. */
  untrackedMinSessions?: number;
  /** Flag a suggestion as a "big change" beyond this fraction. Default 0.15. */
  bigChangePct?: number;
  /** Data older than this many days (newest session) is "stale". Default 45. */
  staleDays?: number;
}

const KG_PER_LB = 0.45359237;
function toUnit(kg: number, unit: WeightUnit): number {
  return unit === "kg" ? kg : kg / KG_PER_LB;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function roundFor(program: Program, exerciseRounding: { increment: number; mode: "nearest" | "floor" | "ceil" } | undefined, value: number): number {
  const fallback = program.cycle.unit === "kg" ? DEFAULT_ROUNDING_KG : DEFAULT_ROUNDING_LB;
  return roundWeight(value, exerciseRounding ?? fallback);
}

/** e1RM (kg) from one working set, or null if it can't bear a load estimate. */
function e1rmFromSet(s: WorkingSet, assumedRpe: number, repCap: number): E1rmSource | null {
  if (s.weightKg == null || s.weightKg <= 0) return null; // bodyweight / unweighted
  if (s.reps > repCap) return null; // high-rep 1RM extrapolation is unreliable
  const hasRpe = typeof s.rpe === "number" && s.rpe > 0 && s.rpe <= 10;
  const rpe = hasRpe ? (s.rpe as number) : s.type === "failure" ? 10 : assumedRpe;
  return {
    weightKg: s.weightKg,
    reps: s.reps,
    rpe: hasRpe ? (s.rpe as number) : null,
    assumedRpe: !hasRpe,
    date: s.date,
    e1rmKg: estimate1RM(s.weightKg, s.reps, rpe),
  };
}

function repRangeOf(sets: WorkingSet[]): { min: number; median: number; max: number } | undefined {
  const reps = sets.map((s) => s.reps);
  if (reps.length === 0) return undefined;
  return { min: Math.min(...reps), median: Math.round(median(reps)), max: Math.max(...reps) };
}

function staleByDays(lastDate: string, now: string | undefined, staleDays: number): boolean {
  if (!now) return false;
  return Date.parse(now) - Date.parse(lastDate) > staleDays * 86_400_000;
}

function downgrade(c: Confidence): Confidence {
  return c === "high" ? "medium" : c === "medium" ? "low" : c;
}

function calibrateExercise(
  program: Program,
  exercise: { id: string; name: string; muscle: MuscleGroup; loadBasis: LoadBasis; e1rm?: number; workWeight?: number; rounding?: { increment: number; mode: "nearest" | "floor" | "ceil" } },
  match: ExerciseMatch,
  hist: ExerciseHistory | undefined,
  o: Required<Pick<CalibrateOptions, "assumedRpe" | "e1rmRepCap" | "topN" | "minSessionsHigh" | "minSessionsMedium" | "recentSessions" | "staleDays" | "bigChangePct">> & { now?: string },
): ExerciseCalibration {
  const unit = program.cycle.unit;
  const current = exercise.loadBasis === "max" ? exercise.e1rm ?? null : exercise.workWeight ?? null;
  const base: ExerciseCalibration = {
    exerciseId: exercise.id,
    exerciseName: exercise.name,
    muscle: exercise.muscle,
    loadBasis: exercise.loadBasis,
    unit,
    matchedTitle: match.templateTitle,
    matchScore: Math.round(match.score * 100) / 100,
    confidence: "none",
    sessions: hist?.sessions ?? 0,
    current,
    suggested: null,
    changePct: null,
    usedRpeFraction: 0,
    rationale: "",
    notes: [],
  };

  if (!hist || !match.templateId) {
    base.rationale = `No Hevy history matched "${exercise.name}" — keeping the current ${exercise.loadBasis === "max" ? "e1RM" : "working weight"} placeholder.`;
    return base;
  }

  const sessions = hist.sessions;
  base.repRange = repRangeOf(hist.workingSets);

  // Confidence from sessions + match quality.
  let confidence: Confidence =
    sessions >= o.minSessionsHigh && match.score >= 0.8
      ? "high"
      : sessions >= o.minSessionsMedium && match.score >= 0.6
        ? "medium"
        : "low";
  if (staleByDays(hist.lastDate, o.now, o.staleDays)) {
    confidence = downgrade(confidence);
    base.notes.push(`Most recent session was ${hist.lastDate.slice(0, 10)} — may not reflect current strength.`);
  }
  // Cross-equipment match (e.g. barbell slot, only a dumbbell variant logged): the
  // load scales differ (total-bar vs per-hand), so never auto-apply — cap at "low".
  if (match.equipmentMismatch && (confidence === "high" || confidence === "medium")) {
    confidence = "low";
    base.notes.push(`Closest Hevy match uses different equipment than "${exercise.name}" — weights aren't comparable (total-bar vs per-hand). Verify before applying.`);
  }

  if (exercise.loadBasis === "max") {
    const sources = hist.workingSets
      .map((s) => e1rmFromSet(s, o.assumedRpe, o.e1rmRepCap))
      .filter((x): x is E1rmSource => x != null);
    if (sources.length === 0) {
      base.confidence = "low";
      base.rationale = `Matched "${hist.title}" but no weighted, sub-${o.e1rmRepCap}-rep sets to estimate a 1RM from — keeping the placeholder.`;
      return base;
    }
    const byE1rm = [...sources].sort((a, b) => b.e1rmKg - a.e1rmKg);
    const top = byE1rm.slice(0, Math.min(o.topN, byE1rm.length));
    const robustKg = median(top.map((s) => s.e1rmKg));
    const suggested = roundFor(program, exercise.rounding, toUnit(robustKg, unit));
    const rpeCount = sources.filter((s) => !s.assumedRpe).length;
    const usedRpeFraction = rpeCount / sources.length;

    base.bestSet = byE1rm[0];
    base.usedRpeFraction = Math.round(usedRpeFraction * 100) / 100;
    base.suggested = suggested;
    base.changePct = current ? Math.round(((suggested - current) / current) * 1000) / 10 : null;
    // Pure assumed-RPE data is less certain — cap at medium.
    if (usedRpeFraction === 0) {
      if (confidence === "high") confidence = "medium";
      base.notes.push(`No RPE logged — estimated from load×reps assuming RPE ${o.assumedRpe} (conservative).`);
    }
    base.confidence = confidence;
    const b = byE1rm[0];
    base.rationale =
      `${sessions} session${sessions === 1 ? "" : "s"} of "${hist.title}". ` +
      `Best set ${fmtKg(b.weightKg, unit)}×${b.reps}${b.rpe != null ? ` @RPE ${b.rpe}` : ""} ⇒ e1RM ≈ ${Math.round(toUnit(b.e1rmKg, unit))}${unit}; ` +
      `suggested ${suggested}${unit} (median of top ${top.length}).`;
    return base;
  }

  // work-basis accessory: median of recent sessions' top working set.
  const recent = hist.perSession.slice(-o.recentSessions);
  const topWeights = recent.map((s) => s.topWeightKg).filter((w): w is number => w != null && w > 0);
  if (topWeights.length === 0) {
    // Bodyweight movement (e.g. pull-ups/hanging leg raises done unweighted).
    base.suggested = 0;
    base.confidence = sessions >= o.minSessionsHigh ? confidence : downgrade(confidence);
    base.changePct = null;
    base.rationale = `Matched "${hist.title}", logged bodyweight (no added load) across ${sessions} session${sessions === 1 ? "" : "s"} — keep working weight 0 and progress by reps.`;
    return base;
  }
  const suggestedKg = median(topWeights);
  const suggested = roundFor(program, exercise.rounding, toUnit(suggestedKg, unit));
  base.suggested = suggested;
  base.confidence = confidence;
  base.changePct = current ? Math.round(((suggested - current) / current) * 1000) / 10 : null;
  const rr = base.repRange;
  base.rationale =
    `${sessions} session${sessions === 1 ? "" : "s"} of "${hist.title}". ` +
    `Recent top set median ${suggested}${unit}` +
    (rr ? ` at ${rr.min}–${rr.max} reps` : "") +
    ` → starting working weight ${suggested}${unit}.`;
  return base;
}

function fmtKg(kg: number, unit: WeightUnit): number {
  return Math.round(toUnit(kg, unit) * 10) / 10;
}

export function calibrate(
  program: Program,
  history: NormalizedHistory,
  matches: ExerciseMatch[],
  opts: CalibrateOptions = {},
): CalibrationReport {
  const o = {
    assumedRpe: opts.assumedRpe ?? 9,
    e1rmRepCap: opts.e1rmRepCap ?? 12,
    topN: opts.topN ?? 3,
    minSessionsHigh: opts.minSessionsHigh ?? 3,
    minSessionsMedium: opts.minSessionsMedium ?? 2,
    recentSessions: opts.recentSessions ?? 6,
    staleDays: opts.staleDays ?? 45,
    bigChangePct: opts.bigChangePct ?? 0.15,
    now: opts.now,
  };
  const untrackedMinSessions = opts.untrackedMinSessions ?? 4;

  const matchByExercise = new Map(matches.map((m) => [m.exerciseId, m]));
  const exercises: ExerciseCalibration[] = [];
  const matchedTemplateIds = new Set<string>();

  for (const day of program.days) {
    for (const ex of day.exercises) {
      if (exercises.some((e) => e.exerciseId === ex.id)) continue;
      const match = matchByExercise.get(ex.id) ?? {
        exerciseId: ex.id, exerciseName: ex.name, templateId: null, templateTitle: null,
        score: 0, equipmentMismatch: false, muscleMismatch: false, alternates: [],
      };
      if (match.templateId) matchedTemplateIds.add(match.templateId);
      const hist = match.templateId ? history.byTemplate.get(match.templateId) : undefined;
      exercises.push(calibrateExercise(program, ex, match, hist, o));
    }
  }

  const recommendations = buildRecommendations(program, history, exercises, matchedTemplateIds, {
    untrackedMinSessions,
    bigChangePct: o.bigChangePct,
    staleDays: o.staleDays,
    now: o.now,
  });

  return {
    program: program.name,
    unit: program.cycle.unit,
    windowDays: history.windowDays,
    now: o.now ?? null,
    workoutsConsidered: history.workoutsConsidered,
    dateRange: history.dateRange,
    user: opts.user,
    exercises,
    recommendations,
  };
}

function buildRecommendations(
  program: Program,
  history: NormalizedHistory,
  exercises: ExerciseCalibration[],
  matchedTemplateIds: Set<string>,
  o: { untrackedMinSessions: number; bigChangePct: number; staleDays: number; now?: string },
): Recommendation[] {
  const recs: Recommendation[] = [];

  // 1. Planned lifts with no history.
  const noHistory = exercises.filter((e) => e.confidence === "none");
  if (noHistory.length) {
    recs.push({
      kind: "no-history",
      severity: "info",
      title: `${noHistory.length} planned lift${noHistory.length === 1 ? "" : "s"} have no Hevy history`,
      detail:
        `Their starting loads stay as placeholders and will be dialed in by the ramp/calibration block: ` +
        noHistory.map((e) => e.exerciseName).join(", ") + ".",
      data: { exercises: noHistory.map((e) => e.exerciseName) },
    });
  }

  // 2. Lifts trained hard but absent from the plan.
  const untracked = [...history.byTemplate.values()]
    .filter((h) => !matchedTemplateIds.has(h.templateId) && h.sessions >= o.untrackedMinSessions && h.muscle)
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 8);
  if (untracked.length) {
    recs.push({
      kind: "untracked-lift",
      severity: "suggest",
      title:
        untracked.length === 1
          ? "You train a lift that isn't in the plan"
          : `You train ${untracked.length} lifts that aren't in the plan`,
      detail:
        untracked.map((h) => `${h.title} (${h.sessions}× — ${h.muscle})`).join(", ") +
        ". Consider whether any belong in the program.",
      data: { lifts: untracked.map((h) => ({ title: h.title, sessions: h.sessions, muscle: h.muscle })) },
    });
  }

  // 3. Volume reality-check: actual weekly sets/muscle vs the plan's landmarks.
  const span = history.dateRange
    ? Math.max(1, (Date.parse(history.dateRange.to) - Date.parse(history.dateRange.from)) / (7 * 86_400_000))
    : history.windowDays
      ? Math.max(1, history.windowDays / 7)
      : 1;
  const actualByMuscle = new Map<MuscleGroup, number>();
  for (const h of history.byTemplate.values()) {
    if (!h.muscle) continue;
    actualByMuscle.set(h.muscle, (actualByMuscle.get(h.muscle) ?? 0) + h.workingSets.length);
  }
  const planned = new Map(planningCheck(program, 1).byMuscle.map((m) => [m.muscle, m.sets]));
  const volNotes: string[] = [];
  for (const [muscle, totalSets] of actualByMuscle) {
    const perWeek = totalSets / span;
    const plan = planned.get(muscle) ?? 0;
    const mrv = VOLUME_LANDMARKS[muscle].mrv;
    if (plan > 0 && perWeek >= plan * 1.5 && perWeek > mrv * 0.8) {
      volNotes.push(`${muscle}: ~${perWeek.toFixed(0)} sets/wk actual vs ${plan} planned (you favor it; the plan may under-dose it for you).`);
    } else if (plan > 0 && perWeek <= plan * 0.5) {
      volNotes.push(`${muscle}: ~${perWeek.toFixed(0)} sets/wk actual vs ${plan} planned (the plan ramps this up — expect more soreness early).`);
    }
  }
  if (volNotes.length) {
    recs.push({
      kind: "volume-reality",
      severity: "info",
      title: "Volume reality-check vs your recent training",
      detail: volNotes.join(" "),
      data: { perWeekSpanWeeks: Math.round(span * 10) / 10 },
    });
  }

  // 4. Big-change flags (calibration meaningfully moved a starting load).
  const big = exercises.filter(
    (e) => e.suggested != null && e.current != null && e.current > 0 && Math.abs((e.suggested - e.current) / e.current) >= o.bigChangePct,
  );
  if (big.length) {
    recs.push({
      kind: "big-change",
      severity: "suggest",
      title: `${big.length} starting load${big.length === 1 ? "" : "s"} change by ≥${Math.round(o.bigChangePct * 100)}%`,
      detail: big
        .map((e) => `${e.exerciseName}: ${e.current}→${e.suggested}${e.unit} (${e.changePct! > 0 ? "+" : ""}${e.changePct}%)`)
        .join(", ") + ". The placeholders were just guesses; these come from your data.",
      data: { exercises: big.map((e) => ({ name: e.exerciseName, from: e.current, to: e.suggested })) },
    });
  }

  // 5. Stale data overall.
  if (o.now && history.dateRange && staleByDays(history.dateRange.to, o.now, o.staleDays)) {
    recs.push({
      kind: "stale-data",
      severity: "warn",
      title: "Your most recent Hevy workout is a while ago",
      detail: `Latest session ${history.dateRange.to.slice(0, 10)}. Suggestions reflect that period; if you've trained since (elsewhere) or detrained, treat the starting weights as a ceiling and let the ramp block recalibrate.`,
    });
  }

  return recs;
}
