/**
 * Weekly autoregulation — advance the program from last week's Hevy actuals.
 *
 * PURE. Reads the matched Hevy sets for each program exercise, runs the engine's
 * progression rule (`progress`) on them, and applies the decision to the
 * exercise's anchor (e1RM for max basis, working weight for work basis). The
 * result is the next week's program: same structure, loads moved by what you
 * actually did. Exercises you didn't train are held unchanged.
 *
 * The engine works in the program's unit (lb here); Hevy serves kg, so sets are
 * converted before they reach the rules. RPE drives the RIR-based rules — when a
 * set has no logged RPE we assume the prescription's target (treat it as "on
 * plan"), which is neutral: it neither over- nor under-rewards.
 */
import type { Program } from "../../engine/types";
import { buildCalendar } from "../../engine/calendar";
import { generateWeekPlans } from "../../engine/periodization";
import { progress } from "../../engine/rules";
import { matchProgramToHistory } from "./match";
import type { NormalizedHistory } from "./normalize";
import { applyDecision, buildResult, type WeeklyChange } from "./impact";
export type { WeeklyChange } from "./impact";

export interface AdvanceResult {
  nextProgram: Program;
  changes: WeeklyChange[];
  /** True if at least one program lift had matching training in the window. */
  trained: boolean;
  /** The week whose results were applied. */
  week: number;
}

export function advanceProgramFromHevy(program: Program, history: NormalizedHistory, week: number): AdvanceResult {
  const matches = matchProgramToHistory(program, history);
  const matchById = new Map(matches.map((m) => [m.exerciseId, m]));
  const calendar = buildCalendar(program.cycle);
  const changes: WeeklyChange[] = [];
  let trained = false;

  const days = program.days.map((day) => ({
    ...day,
    exercises: day.exercises.map((ex) => {
      const m = matchById.get(ex.id);
      const hist = m?.templateId ? history.byTemplate.get(m.templateId) : undefined;
      if (!hist || hist.sessions === 0) return ex;
      const plans = generateWeekPlans(ex.wave, calendar);
      const plan = plans.find((p) => p.week === week) ?? plans[0];
      // Deload weeks are recovery — never progress off them.
      if (plan.isDeload) return ex;
      const result = buildResult(program, ex, hist, plan);
      if (!result) return ex;
      trained = true;
      const decision = progress(ex, plan, result);
      const { next, change } = applyDecision(program, ex, decision, plan);
      change.sessions = hist.sessions;
      changes.push(change);
      return next;
    }),
  }));

  return { nextProgram: { ...program, days }, changes, trained, week };
}
