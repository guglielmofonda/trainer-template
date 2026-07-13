import { promises as fs } from "node:fs";
import path from "node:path";
import type { Program } from "./engine/types";
import { buildCalendar } from "./engine/calendar";
import type { SessionLog } from "./store/types";

export interface CompletedTrainingSession {
  workoutId: string;
  dayId: string;
  week: number;
  date: string;
  title: string;
  source: "hevy";
}

export interface TrainingHistorySnapshot {
  pulledAt: string | null;
  windowDays: number;
  sessions: CompletedTrainingSession[];
}

export interface DayProgress {
  dayId: string;
  dayName: string;
  week: number;
  state: "completed" | "current" | "upcoming";
  completedAt?: string;
  startedAt?: string;
}

const HISTORY_FILE = path.join(process.cwd(), "data", "hevy-history.json");

export async function readTrainingHistory(): Promise<TrainingHistorySnapshot> {
  try {
    const parsed = JSON.parse(await fs.readFile(HISTORY_FILE, "utf8")) as Partial<TrainingHistorySnapshot>;
    return {
      pulledAt: parsed.pulledAt ?? null,
      windowDays: parsed.windowDays ?? 0,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return { pulledAt: null, windowDays: 0, sessions: [] };
  }
}

export function resolveActiveWeek(
  program: Program,
  logs: SessionLog[],
  history: TrainingHistorySnapshot,
  stateWeek: number,
): number {
  const total = buildCalendar(program.cycle).length;
  const candidates = [
    stateWeek,
    ...logs.map((log) => log.week),
    ...history.sessions.map((session) => session.week),
  ].filter(Number.isFinite);
  return clamp(Math.max(1, ...candidates), 1, total);
}

export function getWeekProgress(
  program: Program,
  logs: SessionLog[],
  history: TrainingHistorySnapshot,
  week: number,
): DayProgress[] {
  const hevyByDay = new Map<string, CompletedTrainingSession>();
  for (const session of history.sessions) {
    if (session.week !== week || !program.days.some((day) => day.id === session.dayId)) continue;
    const previous = hevyByDay.get(session.dayId);
    if (!previous || previous.date < session.date) hevyByDay.set(session.dayId, session);
  }

  const nativeByDayAndDate = new Map<string, Set<string>>();
  for (const log of logs) {
    if (log.week !== week) continue;
    const date = log.date.slice(0, 10);
    const key = `${log.dayId}|${date}`;
    const exercises = nativeByDayAndDate.get(key) ?? new Set<string>();
    exercises.add(log.exerciseId);
    nativeByDayAndDate.set(key, exercises);
  }

  const completedAtByDay = new Map<string, string>();
  const startedAtByDay = new Map<string, string>();
  for (const day of program.days) {
    const hevy = hevyByDay.get(day.id);
    if (hevy) completedAtByDay.set(day.id, hevy.date);

    for (const [key, exerciseIds] of nativeByDayAndDate) {
      const [dayId, date] = key.split("|");
      if (dayId !== day.id) continue;
      const previousStarted = startedAtByDay.get(day.id);
      if (!previousStarted || previousStarted < date) startedAtByDay.set(day.id, date);
      if (exerciseIds.size >= day.exercises.length) {
        const previousCompleted = completedAtByDay.get(day.id);
        if (!previousCompleted || previousCompleted < date) completedAtByDay.set(day.id, date);
      }
    }
  }

  const currentIndex = Math.max(
    0,
    program.days.findIndex((day) => !completedAtByDay.has(day.id)),
  );

  return program.days.map((day, index) => {
    const completedAt = completedAtByDay.get(day.id);
    return {
      dayId: day.id,
      dayName: day.name,
      week,
      state: completedAt ? "completed" : index === currentIndex ? "current" : "upcoming",
      completedAt,
      startedAt: completedAt ? undefined : startedAtByDay.get(day.id),
    };
  });
}

export function resolveNextSession(
  program: Program,
  logs: SessionLog[],
  history: TrainingHistorySnapshot,
  activeWeek: number,
): { week: number; dayId: string } {
  const progress = getWeekProgress(program, logs, history, activeWeek);
  const next = progress.find((day) => day.state !== "completed");
  if (next) return { week: activeWeek, dayId: next.dayId };

  const total = buildCalendar(program.cycle).length;
  if (activeWeek < total) return { week: activeWeek + 1, dayId: program.days[0].id };
  return { week: activeWeek, dayId: program.days[program.days.length - 1].id };
}

export function formatCompletedDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate.slice(0, 10)}T12:00:00Z`));
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
