/**
 * Hevy integration — public surface.
 *
 * Pull the athlete's real workout history from Hevy and turn it into starting
 * weights + plan-tuning recommendations for the engine's program. The pieces are
 * pure and testable (normalize → match → calibrate → apply); `HevyClient` is the
 * only I/O. `importFromHevy` is the convenience orchestrator that wires them.
 */
export * from "./types";
export { HevyClient, HevyApiError, HEVY_API_BASE } from "./client";
export type { HevyClientOptions, FetchAllOptions } from "./client";
export { normalizeHistory, hevyMuscleToGroup } from "./normalize";
export type { NormalizedHistory, ExerciseHistory, WorkingSet, SessionRollup } from "./normalize";
export { matchProgramToHistory, bestTemplateMatch, parseTitle, scoreMatch, normalizeName } from "./match";
export type { ExerciseMatch, MatchCandidate, MatchOptions } from "./match";
export { calibrate } from "./calibrate";
export type {
  CalibrationReport,
  ExerciseCalibration,
  Recommendation,
  RecommendationKind,
  Confidence,
  CalibrateOptions,
  E1rmSource,
} from "./calibrate";
export { applyCalibration } from "./apply";
export type { ApplyResult, AppliedChange, SkippedChange, ApplyOptions } from "./apply";
export { advanceProgramFromHevy } from "./advance";
export type { AdvanceResult, WeeklyChange } from "./advance";
export { applyDecision, buildResult, fromKg, parseDayIdFromTitle, parseWeekFromTitle, roundFor, weekForWorkout, workoutImpact } from "./impact";
export type {
  WorkoutActualSet,
  WorkoutExerciseImpact,
  WorkoutExtraImpact,
  WorkoutImpact,
  WorkoutVerdict,
  WorkoutExerciseStatus,
} from "./impact";
export { actualWeekVolume } from "./volume";
export type { WeekActualVolume, MuscleActualVolume } from "./volume";
export { exportWeekToHevy, resolveTemplates, catalogAsHistory } from "./export";
export type {
  ExportOptions,
  ExportResult,
  ResolvedTemplate,
  RoutinePlan,
  RoutineExercisePlan,
  RoutineSetPlan,
} from "./export";

import type { Program } from "../../engine/types";
import { HevyClient, type HevyClientOptions } from "./client";
import { normalizeHistory } from "./normalize";
import { matchProgramToHistory } from "./match";
import { calibrate, type CalibrationReport } from "./calibrate";
import type { ExerciseMatch } from "./match";
import type { NormalizedHistory } from "./normalize";

export interface ImportOptions {
  /** Only consider workouts within this many days. Default 120 (~4 months). */
  windowDays?: number;
  /** Reference "today" (ISO). Defaults to now — this is the I/O layer, so a clock is fine. */
  now?: string;
  /** Match acceptance threshold (0..1). Default 0.6. */
  matchThreshold?: number;
  /** Page-fetch progress callback. */
  onProgress?: (info: { page: number; pageCount: number; fetched: number }) => void;
  /** Skip fetching user info (one fewer request). */
  skipUser?: boolean;
}

export interface ImportResult {
  report: CalibrationReport;
  matches: ExerciseMatch[];
  history: NormalizedHistory;
}

/**
 * End-to-end: fetch history from Hevy, match it to the program, and calibrate.
 * Does NOT mutate or persist anything — call `applyCalibration` with the result
 * to produce an updated program, then persist that.
 */
export async function importFromHevy(
  client: HevyClient,
  program: Program,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const now = opts.now ?? new Date().toISOString();
  const windowDays = opts.windowDays ?? 120;
  const since = new Date(Date.parse(now) - windowDays * 86_400_000).toISOString();

  const [templates, workouts, user] = await Promise.all([
    client.getAllTemplates(),
    client.getAllWorkouts({ since, onProgress: opts.onProgress }),
    opts.skipUser ? Promise.resolve(undefined) : client.getUserInfo().catch(() => undefined),
  ]);

  const history = normalizeHistory(workouts, templates, { windowDays, now });
  const matches = matchProgramToHistory(program, history, { threshold: opts.matchThreshold });
  const report = calibrate(program, history, matches, {
    now,
    windowDays,
    user: user ? { name: user.name } : undefined,
  });

  return { report, matches, history };
}

/** Build a client from an explicit key or the HEVY_API_KEY env var. */
export function hevyClientFromEnv(opts: Partial<HevyClientOptions> = {}): HevyClient {
  const apiKey = opts.apiKey ?? process.env.HEVY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No Hevy API key. Set HEVY_API_KEY (hevy.com → Settings → API; requires Hevy Pro) or pass one explicitly.",
    );
  }
  return new HevyClient({ ...opts, apiKey });
}
