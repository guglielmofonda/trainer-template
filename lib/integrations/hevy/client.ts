/**
 * HevyClient — the *only* I/O in this integration.
 *
 * Everything else (normalize / match / calibrate / apply) is pure and testable;
 * this is the thin shell that talks to the network, mirroring the project's
 * "pure engine, swappable shell" architecture. It is deliberately tiny: no
 * retry framework, no caching layer — just paginated GETs with a small,
 * honest backoff for the one error the API actually throws under load (429).
 *
 * Auth: Hevy uses an `api-key` request header (Hevy Pro → Settings → API /
 * Developer). There is no OAuth and no bearer token.
 */
import type {
  HevyBodyMeasurement,
  HevyExerciseTemplate,
  HevyPaginatedBodyMeasurements,
  HevyPaginatedTemplates,
  HevyPaginatedWorkouts,
  HevyUserInfo,
  HevyUserInfoResponse,
  HevyWorkout,
  HevyWorkoutCount,
} from "./types";

export const HEVY_API_BASE = "https://api.hevyapp.com";

/** Max page sizes the API permits (from the OpenAPI spec). */
const WORKOUTS_PAGE_SIZE = 10;
const TEMPLATES_PAGE_SIZE = 100;
const BODY_MEASUREMENTS_PAGE_SIZE = 10;

export class HevyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "HevyApiError";
  }
}

export interface HevyClientOptions {
  apiKey: string;
  /** Override for tests or self-hosted proxies. Defaults to the public API. */
  baseUrl?: string;
  /** Injectable fetch (tests pass a stub; Node 18+/Next supply a global). */
  fetch?: typeof fetch;
  /** Max attempts per request on 429 / 5xx before giving up. Default 4. */
  maxAttempts?: number;
  /** Sleep impl (tests pass a no-op to avoid real backoff delays). */
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchAllOptions {
  /** Stop after this many pages (safety valve for very large histories). */
  maxPages?: number;
  /** Called after each page so callers can show progress. */
  onProgress?: (info: { page: number; pageCount: number; fetched: number }) => void;
  /** Abort early once a workout older than this ISO date is reached. */
  since?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HevyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: HevyClientOptions) {
    if (!opts.apiKey) throw new Error("HevyClient requires an api key.");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? HEVY_API_BASE).replace(/\/$/, "");
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error("No fetch implementation available — pass one to HevyClient.");
    this.doFetch = f;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Low-level GET with backoff on 429 / 5xx. Returns parsed JSON of type T. */
  private async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    let lastErr: HevyApiError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const res = await this.doFetch(url.toString(), {
        headers: { "api-key": this.apiKey, accept: "application/json" },
      });
      if (res.ok) return (await res.json()) as T;

      const body = await safeText(res);
      const err = new HevyApiError(messageFor(res.status, body), res.status, body);
      // 401/403/404/400 are terminal — retrying won't help. Only back off on 429/5xx.
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt === this.maxAttempts) throw err;
      lastErr = err;
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const waitMs = retryAfter ?? 500 * 2 ** (attempt - 1); // else 0.5s, 1s, 2s…
      await this.sleep(waitMs);
    }
    throw lastErr ?? new HevyApiError("Request failed", 0);
  }

  /** The authenticated user (also the cheapest way to validate an api key). */
  async getUserInfo(): Promise<HevyUserInfo> {
    const res = await this.get<HevyUserInfoResponse>("/v1/user/info");
    return res.data;
  }

  /** Total number of workouts on the account (drives the progress bar). */
  async countWorkouts(): Promise<number> {
    const res = await this.get<HevyWorkoutCount>("/v1/workouts/count");
    return res.workout_count;
  }

  async getWorkoutsPage(page: number, pageSize = WORKOUTS_PAGE_SIZE): Promise<HevyPaginatedWorkouts> {
    return this.get<HevyPaginatedWorkouts>("/v1/workouts", { page, pageSize });
  }

  /**
   * Fetch the entire workout history, page by page (newest first). Hevy caps
   * `pageSize` at 10, so a long history is many requests — the backoff above
   * keeps us under the rate limit. `since` lets callers stop early once they
   * reach workouts older than a cutoff (history is returned newest → oldest).
   */
  async getAllWorkouts(opts: FetchAllOptions = {}): Promise<HevyWorkout[]> {
    const maxPages = opts.maxPages ?? Infinity;
    const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
    const all: HevyWorkout[] = [];

    const first = await this.getWorkoutsPage(1);
    const pageCount = first.page_count || 1;
    pushUntilCutoff(all, first.workouts, sinceMs);
    opts.onProgress?.({ page: 1, pageCount, fetched: all.length });
    if (pageEntirelyBeforeCutoff(first.workouts, sinceMs)) return all;

    const lastPage = Math.min(pageCount, maxPages);
    for (let page = 2; page <= lastPage; page++) {
      const res = await this.getWorkoutsPage(page);
      pushUntilCutoff(all, res.workouts, sinceMs);
      opts.onProgress?.({ page, pageCount, fetched: all.length });
      if (pageEntirelyBeforeCutoff(res.workouts, sinceMs)) break;
    }
    return all;
  }

  async getTemplatesPage(page: number, pageSize = TEMPLATES_PAGE_SIZE): Promise<HevyPaginatedTemplates> {
    return this.get<HevyPaginatedTemplates>("/v1/exercise_templates", { page, pageSize });
  }

  /** All exercise templates on the account (catalog + the user's custom ones). */
  async getAllTemplates(maxPages = 50): Promise<HevyExerciseTemplate[]> {
    const all: HevyExerciseTemplate[] = [];
    const first = await this.getTemplatesPage(1);
    all.push(...first.exercise_templates);
    const pageCount = Math.min(first.page_count || 1, maxPages);
    for (let page = 2; page <= pageCount; page++) {
      const res = await this.getTemplatesPage(page);
      all.push(...res.exercise_templates);
    }
    return all;
  }

  async getBodyMeasurementsPage(
    page: number,
    pageSize = BODY_MEASUREMENTS_PAGE_SIZE,
  ): Promise<HevyPaginatedBodyMeasurements> {
    return this.get<HevyPaginatedBodyMeasurements>("/v1/body_measurements", { page, pageSize });
  }

  /** All dated body measurements on the account (newest first from Hevy). */
  async getAllBodyMeasurements(maxPages = 100): Promise<HevyBodyMeasurement[]> {
    const all: HevyBodyMeasurement[] = [];
    let first: HevyPaginatedBodyMeasurements;
    try {
      first = await this.getBodyMeasurementsPage(1);
    } catch (err) {
      // Hevy uses 404 for an empty/out-of-range measurements page.
      if (err instanceof HevyApiError && err.status === 404) return all;
      throw err;
    }
    all.push(...(first.body_measurements ?? []));
    const pageCount = Math.min(first.page_count || 1, maxPages);
    for (let page = 2; page <= pageCount; page++) {
      const res = await this.getBodyMeasurementsPage(page);
      all.push(...(res.body_measurements ?? []));
    }
    return all;
  }

  /**
   * POST with a JSON body. Creates are NOT idempotent, so — unlike GET — we only
   * retry on 429 (the request was rejected before processing, safe to resend) and
   * NEVER on 5xx (which might have partially created the resource).
   */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const res = await this.doFetch(url, {
        method: "POST",
        headers: { "api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;
      const text = await safeText(res);
      const err = new HevyApiError(messageFor(res.status, text), res.status, text);
      if (res.status !== 429 || attempt === this.maxAttempts) throw err;
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      await this.sleep(retryAfter ?? 500 * 2 ** (attempt - 1));
    }
    throw new HevyApiError("POST failed", 0);
  }

  /** Create a routine. Returns the created routine's id (parsed defensively). */
  async createRoutine(routine: unknown): Promise<{ id?: string; raw: unknown }> {
    const raw = await this.post<unknown>("/v1/routines", { routine });
    return { id: extractId(raw), raw };
  }

  /** Create a routine folder and return its numeric id. */
  async createRoutineFolder(title: string): Promise<{ id: number | null; raw: unknown }> {
    const raw = await this.post<unknown>("/v1/routine_folders", { routine_folder: { title } });
    const id = extractId(raw);
    return { id: id != null ? Number(id) : null, raw };
  }

  /** Create a custom exercise template and return its id. */
  async createExerciseTemplate(exercise: unknown): Promise<{ id: string | null; raw: unknown }> {
    const raw = await this.post<unknown>("/v1/exercise_templates", { exercise });
    const id = extractId(raw);
    return { id: id != null ? String(id) : null, raw };
  }

  /** PUT with a JSON body. PUT is idempotent, so retry on 429 AND 5xx. */
  private async put<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const res = await this.doFetch(url, {
        method: "PUT",
        headers: { "api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;
      const text = await safeText(res);
      const err = new HevyApiError(messageFor(res.status, text), res.status, text);
      if ((res.status !== 429 && res.status < 500) || attempt === this.maxAttempts) throw err;
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      await this.sleep(retryAfter ?? 500 * 2 ** (attempt - 1));
    }
    throw new HevyApiError("PUT failed", 0);
  }

  /** Update an existing routine in place. */
  async updateRoutine(routineId: string, routine: unknown): Promise<{ id?: string; raw: unknown }> {
    const raw = await this.put<unknown>(`/v1/routines/${routineId}`, { routine });
    return { id: extractId(raw) ?? routineId, raw };
  }

  async getRoutinesPage(page: number, pageSize = 10): Promise<{ page: number; page_count: number; routines: HevyRoutineSummary[] }> {
    return this.get(`/v1/routines`, { page, pageSize });
  }

  /** All routines on the account (used to find/update previously-pushed routines). */
  async getAllRoutines(maxPages = 30): Promise<HevyRoutineSummary[]> {
    const all: HevyRoutineSummary[] = [];
    const first = await this.getRoutinesPage(1);
    all.push(...first.routines);
    const pageCount = Math.min(first.page_count || 1, maxPages);
    for (let page = 2; page <= pageCount; page++) {
      const res = await this.getRoutinesPage(page);
      all.push(...res.routines);
    }
    return all;
  }
}

/** Minimal routine summary from GET /v1/routines (enough to find + update one). */
export interface HevyRoutineSummary {
  id: string;
  title: string;
  folder_id: number | null;
  exercises?: unknown[];
}

/** Pull an id out of the various envelope shapes Hevy returns on create. */
function extractId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const candidate =
    o.id ??
    (o.routine as Record<string, unknown> | undefined)?.id ??
    (o.routine_folder as Record<string, unknown> | undefined)?.id ??
    (Array.isArray(o.routines) ? (o.routines[0] as Record<string, unknown>)?.id : undefined) ??
    (Array.isArray(raw) ? (raw[0] as Record<string, unknown>)?.id : undefined);
  return candidate != null ? String(candidate) : undefined;
}

function pushUntilCutoff(into: HevyWorkout[], page: HevyWorkout[], sinceMs: number): void {
  if (Number.isNaN(sinceMs)) {
    into.push(...page);
    return;
  }
  for (const w of page) {
    if (Date.parse(w.start_time) >= sinceMs) into.push(w);
  }
}

function pageEntirelyBeforeCutoff(page: HevyWorkout[], sinceMs: number): boolean {
  if (Number.isNaN(sinceMs) || page.length === 0) return false;
  // The spec gives GET /v1/workouts no ordering guarantee, so we don't assume a
  // strict newest→oldest sort. Only stop paginating once an ENTIRE page predates
  // the cutoff (robust to locally out-of-order entries). Every page is still
  // filtered by start_time, so out-of-window workouts never leak in regardless.
  return page.every((w) => Date.parse(w.start_time) < sinceMs);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : 0;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function safeText(res: Response): Promise<string | undefined> {
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}

function messageFor(status: number, body?: string): string {
  const hint =
    status === 401 || status === 403
      ? "Invalid or missing Hevy API key. Get one at hevy.com → Settings → API (requires Hevy Pro)."
      : status === 429
        ? "Hevy rate limit hit — backing off."
        : status >= 500
          ? "Hevy API server error."
          : "Hevy API request failed.";
  return `${hint} (HTTP ${status})${body ? `: ${body.slice(0, 200)}` : ""}`;
}
