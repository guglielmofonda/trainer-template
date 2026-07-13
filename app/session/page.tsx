import { getStore } from "@/lib/store/fileStore";
import { buildCalendar } from "@/lib/engine/calendar";
import { dayWeekView } from "@/lib/engine";
import { readBlockState } from "@/lib/store/blockState";
import {
  formatCompletedDate,
  getWeekProgress,
  readTrainingHistory,
  resolveActiveWeek,
  resolveNextSession,
} from "@/lib/trainingProgress";
import { PageHeader, Badge } from "@/components/ui";
import { SessionProgressRail } from "@/components/SessionProgressRail";
import { SessionLogger } from "@/components/SessionLogger";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; week?: string }>;
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
  const next = resolveNextSession(program, logs, history, activeWeek);
  const week = clamp(Number(sp.week) || next.week, 1, calendar.length);
  const progress = getWeekProgress(program, logs, history, week);
  const dayId = sp.day ?? (week === next.week ? next.dayId : program.days[0].id);
  const day = program.days.find((d) => d.id === dayId) ?? program.days[0];
  const cw = calendar.find((w) => w.week === week)!;
  const selectedProgress = progress.find((item) => item.dayId === day.id);
  const currentProgress = progress.find((item) => item.state === "current");
  const isToday = week === next.week && day.id === next.dayId;

  const views = dayWeekView(program, day.id, week);

  return (
    <div className="pb-10">
      <PageHeader
        title="Today's session"
        sub={
          selectedProgress?.state === "completed"
            ? `${day.name} was completed ${formatCompletedDate(selectedProgress.completedAt!)}. Review the prescription or choose the next unfinished session in the schedule.`
            : isToday
              ? `${day.name} is today's workout and the next unfinished session in ${cw.label}.`
              : selectedProgress?.state === "upcoming"
                ? `${day.name} follows ${currentProgress?.dayName ?? "the current session"} in ${cw.label}.`
                : `${day.name} is the next unfinished workout in ${cw.label}.`
        }
        right={<Badge tone={cw.isDeload ? "info" : "default"}>{cw.label}</Badge>}
      />

      <div className="sticky top-0 z-[190] bg-bg md:top-[57px]">
        <SessionProgressRail
          days={progress}
          activeDayId={day.id}
          href={(id) => `/session?day=${id}&week=${week}`}
          currentLabel={week === next.week ? "Today" : "Next session"}
        />
      </div>

      <div className="mx-auto max-w-2xl px-5 py-6 sm:px-6">
        <div className="mb-5 flex items-start justify-between gap-5 border-b border-border pb-4">
          <div>
            <div className="label mb-1.5 text-faint">
              {selectedProgress?.state === "completed"
                ? "Completed workout"
                : isToday
                  ? "Today's workout"
                  : selectedProgress?.state === "upcoming"
                    ? "Upcoming workout"
                    : "Do this next"}
            </div>
            <h2 className="text-[1.0625rem] font-semibold tracking-tight text-ink-strong">{day.name}</h2>
            <p className="mt-1 max-w-xl text-xs text-muted">
              Start compounds with the marked warm-up ramp. Only completed work sets drive the next load.
            </p>
          </div>
          <Badge tone={selectedProgress?.state === "completed" ? "success" : "default"}>
            {selectedProgress?.state === "completed"
              ? formatCompletedDate(selectedProgress.completedAt!)
              : isToday
                ? "today"
                : selectedProgress?.state === "upcoming"
                  ? "upcoming"
                  : "next"}
          </Badge>
        </div>
        <SessionLogger
          dayId={day.id}
          week={week}
          unit={program.cycle.unit}
          items={views.map((v) => ({ exercise: v.exercise, plan: v.plan }))}
        />
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
