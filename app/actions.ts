"use server";

import { revalidatePath } from "next/cache";
import { getStore } from "@/lib/store/fileStore";
import { applySession } from "@/lib/engine";
import type { LoggedSet, Program } from "@/lib/engine/types";
import type { SessionLog } from "@/lib/store/types";
import { buildProgressSnapshot, type ProgressSnapshot } from "@/lib/progress";
import {
  HevyClient,
} from "@/lib/integrations/hevy";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Push the website's source of truth (data/store.json) to GitHub via the
 * `program:push` command. The store IS the canonical plan; this is the
 * website → GitHub hop, after which the daily Action pulls Hevy and analyses.
 */
export async function pushProgramToGitHub(): Promise<{ ok: boolean; message: string }> {
  try {
    const { stdout } = await execFileAsync("npm", ["run", "--silent", "program:push"], {
      cwd: process.cwd(),
      timeout: 60_000,
    });
    const last = stdout.trim().split("\n").filter(Boolean).pop() ?? "Pushed program to GitHub.";
    return { ok: true, message: last };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Push failed: ${msg.split("\n")[0]}` };
  }
}

/** Persist a logged session and return the engine's progression decision + next preview. */
export async function logSession(input: {
  dayId: string;
  exerciseId: string;
  week: number;
  date: string; // ISO, passed from the client (engine is clock-free)
  openingSingle?: { weight: number; rpe: number };
  sets: LoggedSet[];
  setsCompleted?: number;
}) {
  const store = getStore();
  const program = await store.getProgram();
  const day = program.days.find((d) => d.id === input.dayId);
  const exercise = day?.exercises.find((e) => e.id === input.exerciseId);
  if (!exercise) throw new Error("Exercise not found");

  const { decision, nextPreview } = applySession(program, exercise, input.week, {
    exerciseId: exercise.id,
    week: input.week,
    openingSingle: input.openingSingle,
    sets: input.sets,
    setsCompleted: input.setsCompleted,
  });

  const log: SessionLog = {
    id: `${input.exerciseId}-w${input.week}-${input.date}`,
    programId: program.id,
    dayId: input.dayId,
    exerciseId: input.exerciseId,
    exerciseName: exercise.name,
    week: input.week,
    date: input.date,
    openingSingle: input.openingSingle,
    sets: input.sets,
    setsCompleted: input.setsCompleted,
    decisionNote: decision.note,
  };
  await store.appendLog(log);
  revalidatePath("/session");
  revalidatePath("/coach");
  return { decision, nextPreview };
}

/** Save edits to the program (configuration). */
export async function saveProgram(program: Program) {
  const store = getStore();
  await store.saveProgram(program);
  revalidatePath("/configuration");
  revalidatePath("/program");
  revalidatePath("/session");
  return { ok: true };
}

/* ------------------------------------------------------------ Hevy progress */

export type HevyProgressResult =
  | { ok: true; snapshot: ProgressSnapshot }
  | { ok: false; error: string };

interface HevyProgressInput {
  /** Number of trailing days to include. */
  windowDays?: number;
}

function resolveHevyKey(): string | null {
  const key = (process.env.HEVY_API_KEY || "").trim();
  return key || null;
}

/** Read major-lift and bodyweight history from Hevy. Does not write anything. */
export async function loadHevyProgress(input: HevyProgressInput): Promise<HevyProgressResult> {
  const key = resolveHevyKey();
  if (!key) {
    console.error("[hevy progress] HEVY_API_KEY is not configured on the server.");
    return {
      ok: false,
      error: "Hevy progress is temporarily unavailable. Ask the coach to try the live connection again.",
    };
  }
  try {
    const windowDays = Math.min(3650, Math.max(30, input.windowDays ?? 365));
    const now = new Date().toISOString();
    const since = new Date(Date.parse(now) - windowDays * 86_400_000).toISOString();
    const client = new HevyClient({
      apiKey: key,
      baseUrl: process.env.HEVY_API_BASE,
    });
    const [workouts, measurements, user] = await Promise.all([
      client.getAllWorkouts({ since, maxPages: 100 }),
      client.getAllBodyMeasurements(),
      client.getUserInfo(),
    ]);
    return {
      ok: true,
      snapshot: buildProgressSnapshot({
        workouts,
        measurements,
        windowDays,
        now,
        athleteName: user.name,
      }),
    };
  } catch (err) {
    console.error("[hevy progress] live refresh failed:", err);
    return {
      ok: false,
      error: "Hevy progress could not be refreshed automatically. Ask the coach to try the live connection again.",
    };
  }
}

/** Toggle the program lock (atomic read-modify-write). */
export async function setProgramLock(locked: boolean) {
  await getStore().updateProgram((program) => ({ ...program, locked }));
  revalidatePath("/configuration");
  return { ok: true, locked };
}
