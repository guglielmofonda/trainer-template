/**
 * Apply a calibration report back into a Program.
 *
 * PURE: returns a NEW program (deep-cloned) and a changelog; never mutates the
 * input. Only confident suggestions are written by default (high + medium) — low
 * and unmatched stay as the program's placeholders, surfaced as recommendations
 * for the athlete to act on manually. This keeps the auto-applied set trustworthy
 * while still showing everything.
 */
import type { Program } from "../../engine/types";
import type { CalibrationReport, Confidence, ExerciseCalibration } from "./calibrate";

export interface AppliedChange {
  exerciseId: string;
  exerciseName: string;
  field: "e1rm" | "workWeight";
  from: number | null;
  to: number;
  confidence: Confidence;
  matchedTitle: string | null;
}

export interface SkippedChange {
  exerciseId: string;
  exerciseName: string;
  reason: "no-data" | "below-confidence" | "no-change";
  confidence: Confidence;
  suggested: number | null;
}

export interface ApplyResult {
  program: Program;
  changes: AppliedChange[];
  skipped: SkippedChange[];
}

const RANK: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 };

export interface ApplyOptions {
  /** Lowest confidence to auto-apply. Default "medium". */
  minConfidence?: Confidence;
}

function cloneProgram(program: Program): Program {
  // structuredClone is available in Node 18+ / modern runtimes; JSON is the fallback.
  return typeof structuredClone === "function"
    ? structuredClone(program)
    : (JSON.parse(JSON.stringify(program)) as Program);
}

export function applyCalibration(
  program: Program,
  report: CalibrationReport,
  opts: ApplyOptions = {},
): ApplyResult {
  const min = RANK[opts.minConfidence ?? "medium"];
  const next = cloneProgram(program);
  const byId = new Map<string, ExerciseCalibration>(report.exercises.map((e) => [e.exerciseId, e]));
  const changes: AppliedChange[] = [];
  const skipped: SkippedChange[] = [];

  for (const day of next.days) {
    for (const ex of day.exercises) {
      const cal = byId.get(ex.id);
      if (!cal) continue;
      const field = ex.loadBasis === "max" ? "e1rm" : "workWeight";

      if (cal.suggested == null) {
        skipped.push({ exerciseId: ex.id, exerciseName: ex.name, reason: "no-data", confidence: cal.confidence, suggested: null });
        continue;
      }
      if (RANK[cal.confidence] < min) {
        skipped.push({ exerciseId: ex.id, exerciseName: ex.name, reason: "below-confidence", confidence: cal.confidence, suggested: cal.suggested });
        continue;
      }
      const from = field === "e1rm" ? ex.e1rm ?? null : ex.workWeight ?? null;
      if (from === cal.suggested) {
        skipped.push({ exerciseId: ex.id, exerciseName: ex.name, reason: "no-change", confidence: cal.confidence, suggested: cal.suggested });
        continue;
      }
      if (field === "e1rm") ex.e1rm = cal.suggested;
      else ex.workWeight = cal.suggested;
      changes.push({
        exerciseId: ex.id,
        exerciseName: ex.name,
        field,
        from,
        to: cal.suggested,
        confidence: cal.confidence,
        matchedTitle: cal.matchedTitle,
      });
    }
  }

  return { program: next, changes, skipped };
}
