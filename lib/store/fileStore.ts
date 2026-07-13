import { promises as fs } from "node:fs";
import path from "node:path";
import type { Program } from "../engine/types";
import { seedProgram } from "../domain/seed";
import { coachThreadTitle, type CoachMessage, type CoachThread, type SessionLog, type Store } from "./types";
import { BlobStore } from "./blobStore";

/**
 * Zero-setup JSON-file store. Lives under ./data/store.json. Seeded from a fresh
 * copy of the reconstructed program on first run. Mutations are serialized through
 * an in-process mutex (read-modify-write is otherwise lost-update-prone under
 * Next.js's concurrent server actions/route handlers), and writes are atomic
 * (temp file + rename). Swap for Convex/Postgres by implementing the Store interface.
 */
interface Shape {
  program: Program;
  logs: SessionLog[];
  coachThreads: CoachThread[];
}

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

async function read(): Promise<Shape> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Shape>;
    // Never hand out the live seed singleton — clone it when falling back.
    return {
      program: parsed.program ?? seedProgram(),
      logs: parsed.logs ?? [],
      coachThreads: parsed.coachThreads ?? [],
    };
  } catch {
    const seeded: Shape = { program: seedProgram(), logs: [], coachThreads: [] };
    await write(seeded);
    return seeded;
  }
}

async function write(shape: Shape): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(shape, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE); // atomic on POSIX
}

export class FileStore implements Store {
  /** Serializes all mutations so concurrent read-modify-write can't lose updates. */
  private chain: Promise<unknown> = Promise.resolve();

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    // keep the chain alive even if a mutation rejects
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async getProgram(): Promise<Program> {
    return (await read()).program;
  }
  saveProgram(program: Program): Promise<void> {
    return this.mutate(async () => {
      const shape = await read();
      shape.program = program;
      await write(shape);
    });
  }
  updateProgram(fn: (program: Program) => Program): Promise<Program> {
    return this.mutate(async () => {
      const shape = await read();
      const next = fn(shape.program);
      shape.program = next;
      await write(shape);
      return next;
    });
  }
  async getLogs(): Promise<SessionLog[]> {
    return (await read()).logs;
  }
  appendLog(log: SessionLog): Promise<SessionLog> {
    return this.mutate(async () => {
      const shape = await read();
      shape.logs.push(log);
      await write(shape);
      return log;
    });
  }
  async getCoachThreads(): Promise<CoachThread[]> {
    return (await read()).coachThreads;
  }
  startCoachThread(firstMessage: CoachMessage): Promise<CoachThread> {
    return this.mutate(async () => {
      const shape = await read();
      const existing = shape.coachThreads.find((thread) =>
        thread.messages.some((message) => message.id === firstMessage.id),
      );
      if (existing) return existing;
      const thread: CoachThread = {
        id: crypto.randomUUID(),
        title: coachThreadTitle(firstMessage.content),
        messages: [firstMessage],
        createdAt: firstMessage.createdAt,
        updatedAt: firstMessage.createdAt,
      };
      shape.coachThreads.push(thread);
      await write(shape);
      return thread;
    });
  }
  appendCoachMessage(threadId: string, message: CoachMessage): Promise<CoachThread> {
    return this.mutate(async () => {
      const shape = await read();
      const thread = shape.coachThreads.find((candidate) => candidate.id === threadId);
      if (!thread) throw new Error("Coach conversation not found.");
      if (!thread.messages.some((existing) => existing.id === message.id)) {
        thread.messages.push(message);
        thread.updatedAt = message.createdAt;
        await write(shape);
      }
      return thread;
    });
  }
}

let singleton: Store | null = null;
export function getStore(): Store {
  if (!singleton) {
    if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) {
      singleton = new BlobStore();
    } else if (process.env.VERCEL === "1") {
      throw new Error(
        "Persistent storage is not configured. Connect a private Vercel Blob store to this project.",
      );
    } else {
      singleton = new FileStore();
    }
  }
  return singleton;
}
