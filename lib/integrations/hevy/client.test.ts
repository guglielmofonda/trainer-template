import { describe, expect, it, vi } from "vitest";
import { HevyApiError, HevyClient } from "./client";
import type { HevyWorkout } from "./types";

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function wk(id: string, startIso: string): HevyWorkout {
  return {
    id,
    title: id,
    start_time: startIso,
    end_time: startIso,
    created_at: startIso,
    updated_at: startIso,
    exercises: [],
  };
}

const noSleep = () => Promise.resolve();

describe("HevyClient", () => {
  it("sends the api-key header and parses user info", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/v1/user/info");
      expect((init?.headers as Record<string, string>)["api-key"]).toBe("secret");
      return jsonResponse({ data: { id: "u1", name: "Lifter", url: "x" } });
    });
    const client = new HevyClient({ apiKey: "secret", fetch: fetch as unknown as typeof globalThis.fetch });
    expect((await client.getUserInfo()).name).toBe("Lifter");
  });

  it("walks every page of workouts", async () => {
    const pages = [
      { page: 1, page_count: 3, workouts: [wk("a", "2026-06-20T10:00:00Z")] },
      { page: 2, page_count: 3, workouts: [wk("b", "2026-06-10T10:00:00Z")] },
      { page: 3, page_count: 3, workouts: [wk("c", "2026-06-01T10:00:00Z")] },
    ];
    const fetch = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return jsonResponse(pages[page - 1]);
    });
    const client = new HevyClient({ apiKey: "k", fetch: fetch as unknown as typeof globalThis.fetch });
    const all = await client.getAllWorkouts();
    expect(all.map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("filters by `since` and stops only once an entire page predates the cutoff", async () => {
    const pages = [
      // mixed page: keep the in-window one, but don't stop (page isn't entirely old)
      { page: 1, page_count: 3, workouts: [wk("new", "2026-06-20T10:00:00Z"), wk("old", "2026-01-01T10:00:00Z")] },
      // entirely before the cutoff → safe to stop here
      { page: 2, page_count: 3, workouts: [wk("older", "2025-12-01T10:00:00Z")] },
      { page: 3, page_count: 3, workouts: [wk("never-fetched", "2025-11-01T10:00:00Z")] },
    ];
    const fetch = vi.fn(async (url: string) => jsonResponse(pages[Number(new URL(url).searchParams.get("page")) - 1]));
    const client = new HevyClient({ apiKey: "k", fetch: fetch as unknown as typeof globalThis.fetch });
    const all = await client.getAllWorkouts({ since: "2026-06-01T00:00:00Z" });
    expect(all.map((w) => w.id)).toEqual(["new"]); // "old"/"older" filtered out by start_time
    expect(fetch).toHaveBeenCalledTimes(2); // page 1 (mixed → continue), page 2 (all old → stop)
  });

  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      return jsonResponse({ workout_count: 7 });
    });
    const client = new HevyClient({ apiKey: "k", fetch: fetch as unknown as typeof globalThis.fetch, sleep: noSleep });
    expect(await client.countWorkouts()).toBe(7);
    expect(calls).toBe(3);
  });

  it("walks every page of body measurements", async () => {
    const pages = [
      {
        page: 1,
        page_count: 2,
        body_measurements: [{ date: "2026-07-10", weight_kg: 80 }],
      },
      {
        page: 2,
        page_count: 2,
        body_measurements: [{ date: "2026-07-01", weight_kg: 79.5 }],
      },
    ];
    const fetch = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return jsonResponse(pages[page - 1]);
    });
    const client = new HevyClient({ apiKey: "k", fetch: fetch as unknown as typeof globalThis.fetch });
    expect((await client.getAllBodyMeasurements()).map((entry) => entry.date)).toEqual([
      "2026-07-10",
      "2026-07-01",
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats an empty body-measurements page as no history", async () => {
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }));
    const client = new HevyClient({ apiKey: "k", fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(client.getAllBodyMeasurements()).resolves.toEqual([]);
  });

  it("throws a helpful HevyApiError on 401 without retrying", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = new HevyClient({ apiKey: "bad", fetch: fetch as unknown as typeof globalThis.fetch, sleep: noSleep });
    await expect(client.getUserInfo()).rejects.toBeInstanceOf(HevyApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
