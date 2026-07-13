import type { LoggedSet, Program } from "../engine/types";

/** A persisted record of one exercise performed in one session. */
export interface SessionLog {
  id: string;
  programId: string;
  dayId: string;
  exerciseId: string;
  exerciseName: string;
  week: number;
  /** ISO date string. */
  date: string;
  openingSingle?: { weight: number; rpe: number };
  sets: LoggedSet[];
  setsCompleted?: number;
  /** The progression note the engine produced when this was logged. */
  decisionNote?: string;
}

/** One durable turn in a Training coach conversation. */
export interface CoachMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** ISO timestamp. */
  createdAt: string;
}

/** A conversation shared by every authenticated session/device. */
export interface CoachThread {
  id: string;
  title: string;
  messages: CoachMessage[];
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

export function coachThreadTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47).trimEnd()}…` : oneLine || "New conversation";
}

/**
 * Persistence boundary. The whole app talks to this interface, so the storage
 * engine is swappable: the bundled implementation is a JSON file (zero-setup,
 * runs anywhere Node runs); a Convex / Postgres adapter would implement the same
 * four methods. See docs/ARCHITECTURE.md.
 */
export interface Store {
  getProgram(): Promise<Program>;
  saveProgram(program: Program): Promise<void>;
  /**
   * Atomic read-modify-write of the program: `fn` runs inside the store mutex on
   * the freshly-read program and returns the next one. Use this for any update
   * that decides what to write based on current state (lock toggle, Hevy apply),
   * so concurrent operations can't lose each other's writes. Returns what `fn`
   * returned.
   */
  updateProgram(fn: (program: Program) => Program): Promise<Program>;
  getLogs(): Promise<SessionLog[]>;
  appendLog(log: SessionLog): Promise<SessionLog>;
  getCoachThreads(): Promise<CoachThread[]>;
  startCoachThread(firstMessage: CoachMessage): Promise<CoachThread>;
  appendCoachMessage(threadId: string, message: CoachMessage): Promise<CoachThread>;
}
