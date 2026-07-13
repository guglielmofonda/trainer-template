import { epley1RM, estimate1RM } from "./engine/e1rm";
import type { HevyBodyMeasurement, HevyWorkout } from "./integrations/hevy";

const LB_PER_KG = 2.204_622_621_8;

export const MAJOR_LIFTS = [
  { key: "squat", label: "Back squat", aliases: ["squat (barbell)", "back squat (barbell)"] },
  { key: "bench", label: "Bench press", aliases: ["bench press (barbell)"] },
  { key: "deadlift", label: "Deadlift", aliases: ["deadlift (barbell)"] },
  { key: "press", label: "Overhead press", aliases: ["overhead press (barbell)", "military press (barbell)"] },
] as const;

export type MajorLiftKey = (typeof MAJOR_LIFTS)[number]["key"];

export interface LiftProgressPoint {
  date: string;
  workoutId: string;
  workoutTitle: string;
  weightLb: number;
  reps: number;
  rpe: number | null;
  estimated1RmLb: number;
  estimateMethod: "rpe" | "epley";
}

export interface LiftProgress {
  key: MajorLiftKey;
  label: string;
  points: LiftProgressPoint[];
  latest: number | null;
  best: number | null;
  changeLb: number | null;
  changePercent: number | null;
}

export interface BodyWeightPoint {
  date: string;
  weightLb: number;
}

export interface BodyWeightProgress {
  points: BodyWeightPoint[];
  latest: number | null;
  changeLb: number | null;
  low: number | null;
  high: number | null;
}

export interface ProgressSnapshot {
  generatedAt: string;
  windowDays: number;
  athleteName?: string;
  workoutsScanned: number;
  lifts: LiftProgress[];
  bodyWeight: BodyWeightProgress;
}

export function buildProgressSnapshot(input: {
  workouts: HevyWorkout[];
  measurements: HevyBodyMeasurement[];
  windowDays: number;
  now?: string;
  athleteName?: string;
}): ProgressSnapshot {
  const now = input.now ?? new Date().toISOString();
  const cutoff = Date.parse(now) - input.windowDays * 86_400_000;
  const workouts = input.workouts.filter((workout) => Date.parse(workout.start_time) >= cutoff);

  const lifts = MAJOR_LIFTS.map((lift) => {
    const points: LiftProgressPoint[] = [];
    for (const workout of workouts) {
      const candidates = workout.exercises
        .filter((exercise) =>
          (lift.aliases as readonly string[]).includes(normalizeTitle(exercise.title)),
        )
        .flatMap((exercise) =>
          exercise.sets
            .filter(isProgressSet)
            .map((set) => {
              const weightLb = set.weight_kg! * LB_PER_KG;
              const useRpe = set.rpe != null && set.rpe >= 6 && set.rpe <= 10;
              const estimated1RmLb = useRpe
                ? estimate1RM(weightLb, set.reps!, set.rpe!)
                : epley1RM(weightLb, set.reps!);
              return {
                date: workout.start_time,
                workoutId: workout.id,
                workoutTitle: workout.title,
                weightLb: roundHalf(weightLb),
                reps: set.reps!,
                rpe: set.rpe,
                estimated1RmLb: Math.round(estimated1RmLb),
                estimateMethod: useRpe ? "rpe" as const : "epley" as const,
              };
            }),
        );
      const best = candidates.sort((a, b) => b.estimated1RmLb - a.estimated1RmLb)[0];
      if (best) points.push(best);
    }
    points.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const first = points[0]?.estimated1RmLb ?? null;
    const latest = points.at(-1)?.estimated1RmLb ?? null;
    const best = points.length ? Math.max(...points.map((point) => point.estimated1RmLb)) : null;
    const changeLb = first != null && latest != null && points.length > 1 ? latest - first : null;
    return {
      key: lift.key,
      label: lift.label,
      points,
      latest,
      best,
      changeLb,
      changePercent: changeLb != null && first ? (changeLb / first) * 100 : null,
    };
  });

  const byDate = new Map<string, BodyWeightPoint>();
  for (const measurement of input.measurements) {
    if (Date.parse(`${measurement.date}T00:00:00Z`) < cutoff) continue;
    if (measurement.weight_kg == null || measurement.weight_kg <= 0) continue;
    byDate.set(measurement.date, {
      date: measurement.date,
      weightLb: roundTenth(measurement.weight_kg * LB_PER_KG),
    });
  }
  const weightPoints = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const firstWeight = weightPoints[0]?.weightLb ?? null;
  const latestWeight = weightPoints.at(-1)?.weightLb ?? null;

  return {
    generatedAt: now,
    windowDays: input.windowDays,
    athleteName: input.athleteName,
    workoutsScanned: workouts.length,
    lifts,
    bodyWeight: {
      points: weightPoints,
      latest: latestWeight,
      changeLb:
        firstWeight != null && latestWeight != null && weightPoints.length > 1
          ? roundTenth(latestWeight - firstWeight)
          : null,
      low: weightPoints.length ? Math.min(...weightPoints.map((point) => point.weightLb)) : null,
      high: weightPoints.length ? Math.max(...weightPoints.map((point) => point.weightLb)) : null,
    },
  };
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function isProgressSet(set: HevyWorkout["exercises"][number]["sets"][number]): boolean {
  return (
    set.type !== "warmup" &&
    set.type !== "dropset" &&
    set.weight_kg != null &&
    set.weight_kg > 0 &&
    set.reps != null &&
    set.reps > 0 &&
    set.reps <= 15
  );
}

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}
