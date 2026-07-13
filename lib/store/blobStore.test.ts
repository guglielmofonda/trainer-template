import { describe, expect, it } from "vitest";
import type { Program } from "../engine/types";
import { BlobStore, type BlobStoreDriver } from "./blobStore";

class Conflict extends Error {}

class MemoryDriver implements BlobStoreDriver {
  body: string | null = null;
  etag = 0;
  conflictsRemaining = 0;

  async read() {
    return this.body == null ? null : { body: this.body, etag: String(this.etag) };
  }

  async write(_pathname: string, body: string, options: { ifMatch?: string }) {
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      throw new Conflict();
    }
    if (options.ifMatch && options.ifMatch !== String(this.etag)) throw new Conflict();
    if (!options.ifMatch && this.body != null) throw new Conflict();
    this.body = body;
    this.etag += 1;
    return { etag: String(this.etag) };
  }

  isConflict(error: unknown) {
    return error instanceof Conflict;
  }
}

describe("BlobStore", () => {
  it("bootstraps from the bundled program and persists updates", async () => {
    const driver = new MemoryDriver();
    const store = new BlobStore(driver);

    const initial = await store.getProgram();
    const updated = await store.updateProgram((program) => ({ ...program, name: "Durable program" }));

    expect(initial.days.length).toBeGreaterThan(0);
    expect(updated.name).toBe("Durable program");
    expect((await store.getProgram()).name).toBe("Durable program");
  });

  it("retries an ETag conflict against the latest state", async () => {
    const driver = new MemoryDriver();
    const store = new BlobStore(driver);
    await store.getProgram();
    driver.conflictsRemaining = 1;

    let calls = 0;
    await store.updateProgram((program) => {
      calls += 1;
      return { ...program, name: `Attempt ${calls}` };
    });

    expect(calls).toBe(2);
    expect((await store.getProgram()).name).toBe("Attempt 2");
  });

  it("serializes logs without dropping the program", async () => {
    const driver = new MemoryDriver();
    const store = new BlobStore(driver);
    const program = await store.getProgram();
    const exercise = program.days[0].exercises[0];
    const log = {
      id: "log-1",
      programId: program.id,
      dayId: program.days[0].id,
      exerciseId: exercise.id,
      exerciseName: exercise.name,
      week: 1,
      date: "2026-07-12",
      sets: [{ weight: 100, reps: 5, rpe: 7 }],
    };

    await store.appendLog(log);

    expect(await store.getLogs()).toEqual([log]);
    expect((await store.getProgram()).id).toBe(program.id);
  });

  it("saves a complete program replacement", async () => {
    const driver = new MemoryDriver();
    const store = new BlobStore(driver);
    const program = await store.getProgram();
    const replacement: Program = { ...program, name: "Replacement" };

    await store.saveProgram(replacement);

    expect((await store.getProgram()).name).toBe("Replacement");
  });

  it("persists coach conversations and keeps message appends idempotent", async () => {
    const driver = new MemoryDriver();
    const store = new BlobStore(driver);
    const userMessage = {
      id: "message-user-1",
      role: "user" as const,
      content: "Review today's training and tell me what to change.",
      createdAt: "2026-07-12T17:00:00.000Z",
    };
    const assistantMessage = {
      id: "message-assistant-1",
      role: "assistant" as const,
      content: "Keep the first two movements as planned.",
      createdAt: "2026-07-12T17:00:05.000Z",
    };

    const thread = await store.startCoachThread(userMessage);
    await store.appendCoachMessage(thread.id, assistantMessage);
    await store.appendCoachMessage(thread.id, assistantMessage);

    const [saved] = await store.getCoachThreads();
    expect(saved.title).toBe("Review today's training and tell me what to cha…");
    expect(saved.messages).toEqual([userMessage, assistantMessage]);
    expect(saved.updatedAt).toBe(assistantMessage.createdAt);
  });

  it("loads older store blobs that do not have coach conversations yet", async () => {
    const driver = new MemoryDriver();
    const store = new BlobStore(driver);
    const program = await store.getProgram();
    driver.body = JSON.stringify({ program, logs: [] });

    expect(await store.getCoachThreads()).toEqual([]);
  });
});
