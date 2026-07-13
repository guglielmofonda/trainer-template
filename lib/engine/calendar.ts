import type { CalendarWeek, CycleConfig } from "./types";

/**
 * Expand a cycle skeleton ("6 on / 1 off · 3 mesos") into a flat week calendar.
 * Deload weeks are placed at the *end* of each mesocycle.
 *
 * Matt's default: weeksOn 6, weeksOff 1, mesocycles 3 → 21 weeks, with deloads
 * landing on weeks 7, 14, 21.
 */
export function buildCalendar(cycle: CycleConfig): CalendarWeek[] {
  const weeks: CalendarWeek[] = [];
  let global = 0;
  for (let meso = 1; meso <= cycle.mesocycles; meso++) {
    for (let w = 1; w <= cycle.weeksOn; w++) {
      global++;
      weeks.push({
        week: global,
        meso,
        weekInMeso: w,
        isDeload: false,
        label: `M${meso} W${global}`,
      });
    }
    for (let d = 1; d <= cycle.weeksOff; d++) {
      global++;
      weeks.push({
        week: global,
        meso,
        weekInMeso: cycle.weeksOn + d,
        isDeload: true,
        label: `M${meso} W${global} · deload`,
      });
    }
  }
  return weeks;
}

export function totalWeeks(cycle: CycleConfig): number {
  return (cycle.weeksOn + cycle.weeksOff) * cycle.mesocycles;
}

export function trainingWeekCount(cycle: CycleConfig): number {
  return cycle.weeksOn * cycle.mesocycles;
}
