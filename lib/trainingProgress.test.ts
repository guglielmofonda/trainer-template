import { describe, expect, it } from "vitest";
import { seedProgram } from "./domain/seed";
import type { SessionLog } from "./store/types";
import {
  getWeekProgress,
  resolveActiveWeek,
  resolveNextSession,
  type TrainingHistorySnapshot,
} from "./trainingProgress";

function fixture() {
  const program = seedProgram();
  program.cycle = { ...program.cycle, weeksOn: 2, weeksOff: 0, mesocycles: 1 };
  program.days = program.days.slice(0, 3);
  return program;
}

describe("training progress", () => {
  it("uses completed Hevy sessions to select the next unfinished day in the active week", () => {
    const program = fixture();
    const first = program.days[0];
    const history: TrainingHistorySnapshot = {
      pulledAt: "2026-07-12T01:00:00Z",
      windowDays: 14,
      sessions: [
        {
          workoutId: "hevy-1",
          dayId: first.id,
          week: 2,
          date: "2026-07-09",
          title: "W2 day 1",
          source: "hevy",
        },
      ],
    };

    expect(resolveActiveWeek(program, [], history, 1)).toBe(2);
    expect(getWeekProgress(program, [], history, 2).map((day) => day.state)).toEqual([
      "completed",
      "current",
      "upcoming",
    ]);
    expect(resolveNextSession(program, [], history, 2)).toEqual({
      week: 2,
      dayId: program.days[1].id,
    });
  });

  it("does not mark a native session complete until every programmed exercise is logged", () => {
    const program = fixture();
    const day = program.days[0];
    const log = (exerciseId: string): SessionLog => ({
      id: exerciseId,
      programId: program.id,
      dayId: day.id,
      exerciseId,
      exerciseName: exerciseId,
      week: 1,
      date: "2026-07-12T12:00:00Z",
      sets: [{ weight: 100, reps: 5, rpe: 8 }],
    });

    const partial = [log(day.exercises[0].id)];
    expect(getWeekProgress(program, partial, { pulledAt: null, windowDays: 0, sessions: [] }, 1)[0]).toMatchObject({
      state: "current",
      startedAt: "2026-07-12",
    });

    const complete = day.exercises.map((exercise) => log(exercise.id));
    expect(getWeekProgress(program, complete, { pulledAt: null, windowDays: 0, sessions: [] }, 1)[0]).toMatchObject({
      state: "completed",
      completedAt: "2026-07-12",
    });
  });
});
