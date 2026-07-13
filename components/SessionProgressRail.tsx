import Link from "next/link";
import { Check, ArrowRight } from "lucide-react";
import { formatCompletedDate, type DayProgress } from "@/lib/trainingProgress";

export function SessionProgressRail({
  days,
  activeDayId,
  href,
  currentLabel = "Next session",
}: {
  days: DayProgress[];
  activeDayId?: string;
  href: (dayId: string) => string;
  currentLabel?: string;
}) {
  return (
    <nav aria-label={`Week ${days[0]?.week ?? ""} session progress`} className="overflow-x-auto">
      <ol className="grid w-full min-w-[45rem] grid-cols-3 border-y border-border-soft bg-surface/45 px-4 sm:px-6">
        {days.map((day, index) => {
          const active = day.dayId === activeDayId;
          const completed = day.state === "completed";
          const current = day.state === "current";
          return (
            <li key={day.dayId} className="relative flex min-w-0 items-stretch border-r border-border-soft first:border-l">
              <Link
                href={href(day.dayId)}
                aria-current={active ? "step" : undefined}
                className={`group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors duration-[var(--dur-fast)] ease-out hover:bg-surface-2/70 ${
                  active ? "bg-bg" : ""
                }`}
              >
                <span
                  className={`tabular flex size-7 shrink-0 items-center justify-center border text-[0.6875rem] font-semibold ${
                    completed
                      ? "border-success bg-success text-bg"
                      : current
                        ? "border-ink-strong bg-ink-strong text-bg"
                        : "border-border bg-bg text-muted"
                  }`}
                  aria-hidden="true"
                >
                  {completed ? <Check className="size-3.5" strokeWidth={2.4} /> : index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[0.6875rem] font-medium ${completed ? "text-success" : current ? "text-ink-strong" : "text-faint"}`}>
                    {completed
                      ? `Completed ${formatCompletedDate(day.completedAt!)}`
                      : day.startedAt
                        ? `In progress ${formatCompletedDate(day.startedAt)}`
                        : current
                          ? currentLabel
                          : "Upcoming"}
                  </span>
                  <span className={`mt-0.5 block truncate text-[0.8125rem] ${active ? "font-semibold text-ink-strong" : "text-muted"}`}>
                    {day.dayName}
                  </span>
                </span>
                {current && <ArrowRight className="size-3.5 shrink-0 text-ink-strong" aria-hidden="true" />}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
