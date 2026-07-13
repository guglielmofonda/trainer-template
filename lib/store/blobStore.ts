import {
  BlobPreconditionFailedError,
  get,
  put,
} from "@vercel/blob";
import { readFileSync } from "node:fs";
import path from "node:path";
import { seedProgram } from "../domain/seed";
import type { Program } from "../engine/types";
import { coachThreadTitle, type CoachMessage, type CoachThread, type SessionLog, type Store } from "./types";

const STORE_PATH = "trainer/store.json";
const MAX_WRITE_ATTEMPTS = 5;

interface StoreShape {
  program: Program;
  logs: SessionLog[];
  coachThreads: CoachThread[];
}

interface BlobSnapshot {
  body: string;
  etag: string;
}

interface BlobWriteOptions {
  ifMatch?: string;
}

/** Small injectable boundary so concurrency behavior can be tested offline. */
export interface BlobStoreDriver {
  read(pathname: string): Promise<BlobSnapshot | null>;
  write(pathname: string, body: string, options: BlobWriteOptions): Promise<{ etag: string }>;
  isConflict(error: unknown): boolean;
}

const vercelBlobDriver: BlobStoreDriver = {
  async read(pathname) {
    const result = await get(pathname, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return {
      body: await new Response(result.stream).text(),
      // Private origin reads currently return a weak validator (`W/"…"`) while
      // conditional writes require the matching strong ETag.
      etag: result.blob.etag.replace(/^W\//, ""),
    };
  },
  async write(pathname, body, options) {
    const result = await put(pathname, body, {
      access: "private",
      contentType: "application/json",
      allowOverwrite: Boolean(options.ifMatch),
      ifMatch: options.ifMatch,
      cacheControlMaxAge: 60,
    });
    return { etag: result.etag };
  },
  isConflict(error) {
    return error instanceof BlobPreconditionFailedError;
  },
};

function bundledShape(): StoreShape {
  // A committed data/store.json (the repo snapshot) bootstraps a brand-new Blob,
  // so a deploy starts from the athlete's program. A fresh template has no
  // snapshot yet and starts from the seed program instead.
  let bundled: Partial<StoreShape> = {};
  try {
    bundled = JSON.parse(
      readFileSync(path.join(process.cwd(), "data", "store.json"), "utf8"),
    ) as Partial<StoreShape>;
  } catch {
    /* no committed snapshot — fall through to the seed */
  }
  return {
    program: bundled.program ?? seedProgram(),
    logs: bundled.logs ?? [],
    coachThreads: bundled.coachThreads ?? [],
  };
}

function parseShape(raw: string): StoreShape {
  const parsed = JSON.parse(raw) as Partial<StoreShape>;
  return {
    program: parsed.program ?? seedProgram(),
    logs: parsed.logs ?? [],
    coachThreads: parsed.coachThreads ?? [],
  };
}

/**
 * Durable production store backed by a private Vercel Blob.
 *
 * Every mutation is a compare-and-swap against the ETag read from origin. That
 * preserves the FileStore atomic-update contract even when separate Vercel
 * function instances write concurrently.
 */
export class BlobStore implements Store {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly driver: BlobStoreDriver = vercelBlobDriver) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async readOrCreate(): Promise<{ shape: StoreShape; etag: string }> {
    const existing = await this.driver.read(STORE_PATH);
    if (existing) return { shape: parseShape(existing.body), etag: existing.etag };

    const shape = bundledShape();
    try {
      const created = await this.driver.write(STORE_PATH, JSON.stringify(shape, null, 2), {});
      return { shape, etag: created.etag };
    } catch (error) {
      // Another function may have initialized the blob after our read.
      const winner = await this.driver.read(STORE_PATH);
      if (winner) return { shape: parseShape(winner.body), etag: winner.etag };
      throw error;
    }
  }

  private mutate<T>(transform: (shape: StoreShape) => T): Promise<T> {
    return this.serialize(async () => {
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
        const { shape, etag } = await this.readOrCreate();
        const value = transform(shape);
        try {
          await this.driver.write(STORE_PATH, JSON.stringify(shape, null, 2), { ifMatch: etag });
          return value;
        } catch (error) {
          if (!this.driver.isConflict(error) || attempt === MAX_WRITE_ATTEMPTS) throw error;
        }
      }
      throw new Error("Persistent store update did not converge.");
    });
  }

  async getProgram(): Promise<Program> {
    return (await this.readOrCreate()).shape.program;
  }

  saveProgram(program: Program): Promise<void> {
    return this.mutate((shape) => {
      shape.program = program;
    });
  }

  updateProgram(fn: (program: Program) => Program): Promise<Program> {
    return this.mutate((shape) => {
      const next = fn(shape.program);
      shape.program = next;
      return next;
    });
  }

  async getLogs(): Promise<SessionLog[]> {
    return (await this.readOrCreate()).shape.logs;
  }

  appendLog(log: SessionLog): Promise<SessionLog> {
    return this.mutate((shape) => {
      shape.logs.push(log);
      return log;
    });
  }

  async getCoachThreads(): Promise<CoachThread[]> {
    return (await this.readOrCreate()).shape.coachThreads;
  }

  startCoachThread(firstMessage: CoachMessage): Promise<CoachThread> {
    return this.mutate((shape) => {
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
      return thread;
    });
  }

  appendCoachMessage(threadId: string, message: CoachMessage): Promise<CoachThread> {
    return this.mutate((shape) => {
      const thread = shape.coachThreads.find((candidate) => candidate.id === threadId);
      if (!thread) throw new Error("Coach conversation not found.");
      if (!thread.messages.some((existing) => existing.id === message.id)) {
        thread.messages.push(message);
        thread.updatedAt = message.createdAt;
      }
      return thread;
    });
  }
}
