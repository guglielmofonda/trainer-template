/**
 * Hevy API DTOs — typed against the public OpenAPI spec at
 * https://api.hevyapp.com/docs/ (openapi 3.0.0, "Hevy API Docs 0.0.1").
 *
 * Field names mirror the wire format exactly (snake_case, `weight_kg`, etc.) so
 * the client is a faithful, low-surprise reflection of the API. Everything the
 * rest of the integration consumes is converted into the engine's own vocabulary
 * by `normalize.ts`, which is where the snake_case stops.
 *
 * Notes from the spec worth pinning here (they drive parsing decisions):
 *  - Auth is an `api-key` *header* (not a bearer token). Hevy Pro only.
 *  - Weights are always kilograms (`weight_kg`); the engine program may be in lb.
 *  - Most numeric set fields are nullable: a bodyweight set has `weight_kg: null`,
 *    a duration/distance exercise has `reps: null`, RPE is usually null (few
 *    users log it). The normalizer treats every one of these as "missing", not 0.
 *  - `GET /v1/workouts` and `GET /v1/body_measurements` are paginated,
 *    `pageSize` max 10; templates max 100.
 */

/** Hevy logs each set with a type; only non-warmup sets count as working volume. */
export type HevySetType = "warmup" | "normal" | "failure" | "dropset" | string;

export interface HevySet {
  index: number;
  type: HevySetType;
  /** Kilograms. Null for bodyweight / non-weighted exercises. */
  weight_kg: number | null;
  reps: number | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  /** Rate of Perceived Exertion 1..10. Usually null — most users don't log it. */
  rpe: number | null;
  custom_metric: number | null;
}

export interface HevyExercise {
  index: number;
  title: string;
  notes?: string;
  /** Stable id of the exercise template this performance is an instance of. */
  exercise_template_id: string;
  superset_id?: number | null;
  /** The spec example uses `supersets_id`; accept either for resilience. */
  supersets_id?: number | null;
  sets: HevySet[];
}

export interface HevyWorkout {
  id: string;
  title: string;
  routine_id?: string | null;
  description?: string | null;
  /** ISO-8601, e.g. "2021-09-14T12:00:00Z". */
  start_time: string;
  end_time: string;
  updated_at: string;
  created_at: string;
  exercises: HevyExercise[];
}

/** A reusable exercise definition (the catalog entry a performance points at). */
export interface HevyExerciseTemplate {
  id: string;
  title: string;
  /** e.g. "weight_reps", "reps_only", "bodyweight_reps", "duration", "distance". */
  type: string;
  /** Lowercase muscle slug, e.g. "chest", "quadriceps", "lats". */
  primary_muscle_group: string;
  secondary_muscle_groups: string[];
  is_custom: boolean;
}

export interface HevyUserInfo {
  id: string;
  name: string;
  url: string;
}

/** A dated measurement entry from Hevy. The progress UI currently reads weight. */
export interface HevyBodyMeasurement {
  /** Calendar date in YYYY-MM-DD format. */
  date: string;
  weight_kg: number | null;
  lean_mass_kg?: number | null;
  fat_percent?: number | null;
}

/* ----------------------------------------------------------- envelopes ---- */

export interface HevyPaginatedWorkouts {
  page: number;
  page_count: number;
  workouts: HevyWorkout[];
}

export interface HevyPaginatedTemplates {
  page: number;
  page_count: number;
  exercise_templates: HevyExerciseTemplate[];
}

export interface HevyPaginatedBodyMeasurements {
  page: number;
  page_count: number;
  body_measurements: HevyBodyMeasurement[];
}

export interface HevyWorkoutCount {
  workout_count: number;
}

export interface HevyUserInfoResponse {
  data: HevyUserInfo;
}
