import { getStore } from "@/lib/store/fileStore";
import { buildCalendar } from "@/lib/engine/calendar";
import { dayWeekView } from "@/lib/engine";
import { readBlockState } from "@/lib/store/blockState";
import {
  formatCompletedDate,
  getWeekProgress,
  readTrainingHistory,
  resolveActiveWeek,
} from "@/lib/trainingProgress";
import { RULE_META } from "@/lib/engine/rules";
import { PageHeader, Panel, Badge, WeekRail } from "@/components/ui";
import { SessionProgressRail } from "@/components/SessionProgressRail";

export const dynamic = "force-dynamic";

export default async function ProgramPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const store = getStore();
  const [program, logs, history, state] = await Promise.all([
    store.getProgram(),
    store.getLogs(),
    readTrainingHistory(),
    readBlockState(),
  ]);
  const calendar = buildCalendar(program.cycle);
  const sp = await searchParams;
  const activeWeek = resolveActiveWeek(program, logs, history, state.currentWeek);
  const week = clamp(Number(sp.week) || activeWeek, 1, calendar.length);
  const cw = calendar.find((w) => w.week === week)!;
  const progress = getWeekProgress(program, logs, history, week);
  const statusByDay = new Map(progress.map((day) => [day.dayId, day]));

  return (
    <div className="pb-10">
      <PageHeader
        title="Program"
        sub="Every exercise's prescription for the selected week. Big compounds include marked warm-up ramps before any working reps."
        right={<Badge tone={cw.isDeload ? "info" : "default"}>{cw.label}</Badge>}
      />

      {/* Week rail */}
      <div className="sticky top-0 z-[190] border-b border-border bg-bg px-4 py-2.5 sm:px-6 md:top-[57px]">
        <WeekRail
          weeks={calendar}
          active={week}
          href={(w) => `/program?week=${w}`}
        />
      </div>

      <SessionProgressRail
        days={progress}
        href={(dayId) => `/session?day=${dayId}&week=${week}`}
      />

      <div className="space-y-5 px-5 py-5 sm:px-6">
        {program.days.map((day) => {
          const views = dayWeekView(program, day.id, week);
          const status = statusByDay.get(day.id)!;
          return (
            <Panel key={day.id} className="overflow-hidden">
              <div className="flex items-start justify-between gap-3 border-b border-border-soft px-4 py-3">
                <div className="min-w-0">
                  <h2 className="text-[0.9375rem] font-semibold tracking-tight">{day.name}</h2>
                  <div className={`mt-0.5 text-[0.6875rem] ${status.state === "completed" ? "text-success" : "text-faint"}`}>
                    {status.state === "completed"
                      ? `Completed ${formatCompletedDate(status.completedAt!)}`
                      : status.startedAt
                        ? `In progress since ${formatCompletedDate(status.startedAt)}`
                        : "Not completed"}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                  <Badge tone={status.state === "completed" ? "success" : status.state === "current" ? "default" : "info"}>
                    {status.state === "completed" ? "done" : status.state === "current" ? "next" : "upcoming"}
                  </Badge>
                  <span className="tabular text-xs text-faint">{views.length} exercises</span>
                </div>
              </div>

              {/* Mobile: load-first stacked rows — the numbers are the hero, not the chrome. */}
              <ul className="divide-y divide-border-soft/70 md:hidden">
                {views.map(({ exercise, plan, prescription }) => (
                  <li key={exercise.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium leading-snug">{exercise.name}</div>
                        <div className="mt-0.5 text-[0.6875rem] text-faint">
                          {exercise.muscle} · {RULE_META[exercise.rule].name}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="tabular font-medium leading-none">
                          <span className="text-base">
                            {loadLabel(prescription.load, program.cycle.unit, exercise.perHand)}
                          </span>
                        </div>
                        <div className="tabular mt-1 text-[0.6875rem] text-muted">
                          {plan.sets} × {plan.reps} · {prescription.rirCutoff} RIR
                        </div>
                      </div>
                    </div>
                    {exercise.usesOpeningSingle && prescription.openingSingle && (
                      <div className="tabular mt-1.5 text-[0.6875rem] text-ink-strong">
                        opening single ≈ {prescription.openingSingle.weight}@
                        {prescription.openingSingle.rpe}
                      </div>
                    )}
                    {prescription.warmupSets.length > 0 && (
                      <div className="tabular mt-1.5 text-[0.6875rem] text-info">
                        warm-up · {warmupLabel(prescription.warmupSets, program.cycle.unit, exercise.perHand)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-faint">
                      <th className="px-4 py-2 font-medium">Exercise</th>
                      <th className="px-2 py-2 font-medium">Muscle</th>
                      <th className="px-2 py-2 font-medium">Rule</th>
                      <th className="px-2 py-2 text-right font-medium">Load</th>
                      <th className="px-2 py-2 text-center font-medium">Sets × Reps</th>
                      <th className="px-2 py-2 text-center font-medium">Stop @</th>
                      <th className="px-4 py-2 text-right font-medium">Goal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {views.map(({ exercise, plan, prescription }) => (
                      <tr
                        key={exercise.id}
                        className="border-t border-border-soft/70 transition-colors hover:bg-surface-2/40"
                      >
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{exercise.name}</div>
                          {exercise.usesOpeningSingle && prescription.openingSingle && (
                            <div className="tabular mt-0.5 text-[0.6875rem] text-ink-strong">
                              opening single ≈ {prescription.openingSingle.weight}@
                              {prescription.openingSingle.rpe}
                            </div>
                          )}
                          {prescription.warmupSets.length > 0 && (
                            <div className="tabular mt-0.5 text-[0.6875rem] text-info">
                              warm-up · {warmupLabel(prescription.warmupSets, program.cycle.unit, exercise.perHand)}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-xs text-muted">
                          {exercise.muscle}
                        </td>
                        <td className="px-2 py-2.5 text-xs text-muted">
                          {RULE_META[exercise.rule].name}
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <span className="tabular font-medium">
                            {loadLabel(prescription.load, program.cycle.unit, exercise.perHand)}
                          </span>
                        </td>
                        <td className="tabular px-2 py-2.5 text-center text-muted">
                          {plan.sets} × {plan.reps}
                        </td>
                        <td className="tabular px-2 py-2.5 text-center text-muted">
                          {prescription.rirCutoff} RIR
                        </td>
                        <td className="px-4 py-2.5 text-right text-xs text-faint">
                          {goalLabel(exercise)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}

function loadLabel(load: number, unit: string, perHand?: boolean) {
  if (load === 0) return "BW";
  return `${load}${unit}${perHand ? " / hand" : ""}`;
}

function warmupLabel(sets: { load: number; reps: number }[], unit: string, perHand?: boolean) {
  return sets.map((set) => `${loadLabel(set.load, unit, perHand)} × ${set.reps}`).join(" → ");
}

function goalLabel(e: { repCap?: number; repTarget?: number; rirCap?: number }) {
  if (e.repCap) return `rep cap ${e.repCap}`;
  if (e.repTarget) return `rep target ${e.repTarget}`;
  if (e.rirCap) return `RIR cap ${e.rirCap}`;
  return "—";
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
