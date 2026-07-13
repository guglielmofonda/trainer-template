import { AlertTriangle, BarChart3, ClipboardList } from "lucide-react";
import { Badge, PageHeader, Panel, PanelHeader, VERDICT_META } from "@/components/ui";
import { getStore } from "@/lib/store/fileStore";
import { readBlockState } from "@/lib/store/blockState";
import {
  actualWeekVolume,
  hevyClientFromEnv,
  weekForWorkout,
  workoutImpact,
  type MuscleActualVolume,
  type WeekActualVolume,
  type WorkoutExerciseImpact,
  type WorkoutExtraImpact,
  type WorkoutImpact,
  type WorkoutVerdict,
} from "@/lib/integrations/hevy";
import { buildCalendar } from "@/lib/engine/calendar";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;

export default async function ReviewPage() {
  const store = getStore();
  const [program, state] = await Promise.all([store.getProgram(), readBlockState()]);
  const calendar = buildCalendar(program.cycle);

  let client;
  try {
    client = hevyClientFromEnv();
  } catch (err) {
    console.error("[workout review] server-side Hevy connection unavailable:", err);
    return (
      <ReviewShell>
        <StatePanel
          tone="warning"
          title="Hevy temporarily unavailable"
          message="Recent workouts could not be loaded automatically. Ask the coach to try the live connection again."
        />
      </ReviewShell>
    );
  }

  try {
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const [templates, workouts] = await Promise.all([
      client.getAllTemplates(),
      client.getAllWorkouts({ since }),
    ]);

    // Impacts for every workout in the window feed the weekly volume stats;
    // only the most recent ones get a full panel.
    const allImpacts = workouts.flatMap((workout) => {
      const week = weekForWorkout(workout, state.startDate, calendar.length);
      return week == null ? [] : [workoutImpact(program, workout, templates, week)];
    });
    const impacts = allImpacts.slice(0, 10);

    const weeks = new Map<number, WorkoutImpact[]>();
    for (const impact of impacts) {
      const group = weeks.get(impact.week) ?? [];
      group.push(impact);
      weeks.set(impact.week, group);
    }

    return (
      <ReviewShell>
        {impacts.length === 0 ? (
          <StatePanel tone="default" title="No recent Hevy workouts" message="Recent workouts will appear here after Hevy returns them." />
        ) : (
          <div className="space-y-7 px-5 py-5 sm:px-6">
            {[...weeks.entries()].map(([week, group]) => (
              <section key={week} className="space-y-5">
                <WeekVolumePanel
                  volume={actualWeekVolume(program, allImpacts, week)}
                  inProgress={week === state.currentWeek}
                />
                {group.map((impact) => (
                  <WorkoutPanel key={impact.workoutId} impact={impact} unit={program.cycle.unit} />
                ))}
              </section>
            ))}
          </div>
        )}
      </ReviewShell>
    );
  } catch (err) {
    console.error("[workout review] live Hevy refresh failed:", err);
    return (
      <ReviewShell>
        <StatePanel
          tone="danger"
          title="Could not fetch Hevy"
          message="Recent workouts could not be refreshed automatically. Ask the coach to try the live connection again."
        />
      </ReviewShell>
    );
  }
}

function ReviewShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="pb-10">
      <PageHeader
        title="Workout review"
        sub="Recent Hevy sessions matched to the plan, with the progression impact shown exercise by exercise."
        right={<Badge tone="info">last 30 days</Badge>}
      />
      {children}
    </div>
  );
}

function StatePanel({
  tone,
  title,
  message,
}: {
  tone: "default" | "warning" | "danger";
  title: string;
  message: string;
}) {
  const Icon = tone === "danger" ? AlertTriangle : ClipboardList;
  return (
    <div className="px-5 py-5 sm:px-6">
      <Panel>
        <div className="flex items-start gap-3 px-4 py-4">
          <Icon className="mt-0.5 size-4 shrink-0 text-faint" />
          <div className="min-w-0">
            <div className="font-medium text-ink">{title}</div>
            <p className="mt-1 text-sm leading-relaxed text-muted">{message}</p>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function WorkoutPanel({ impact, unit }: { impact: WorkoutImpact; unit: string }) {
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title={impact.workoutTitle}
        meta={formatDate(impact.startTime)}
        icon={<ClipboardList className="size-4" />}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={impact.day ? "default" : "warning"}>
              {impact.day?.name ?? "No matching day"}
            </Badge>
            <span className="text-xs text-muted">{summaryText(impact)}</span>
          </div>
        }
      />

      {impact.day ? (
        <>
          <div className="divide-y divide-border-soft/70 md:hidden">
            {impact.exercises.map((row) => (
              <MobileRow key={row.exercise.id} row={row} unit={unit} />
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium">Exercise</th>
                  <th className="px-2 py-2 font-medium">Plan</th>
                  <th className="px-2 py-2 font-medium">Did</th>
                  <th className="px-2 py-2 font-medium">Verdict</th>
                  <th className="px-4 py-2 font-medium">Next week</th>
                </tr>
              </thead>
              <tbody>
                {impact.exercises.map((row) => (
                  <DesktopRow key={row.exercise.id} row={row} unit={unit} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="px-4 py-4 text-sm text-muted">No plan marker or exercise overlap was strong enough to match this workout.</div>
      )}

      {(impact.extras.length > 0 || impact.skipped.length > 0) && (
        <div className="space-y-2 border-t border-border-soft bg-surface-2/35 px-4 py-3 text-xs text-muted">
          {impact.extras.length > 0 && (
            <div>
              <span className="font-medium text-ink">Also did (not planned):</span>{" "}
              {extrasText(impact.extras, unit)}
            </div>
          )}
          {impact.skipped.length > 0 && (
            <div>
              <span className="font-medium text-ink">Skipped:</span>{" "}
              {impact.skipped.map((row) => row.exercise.name).join(", ")}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

/**
 * Actual sets per muscle for one program week — planned, swapped, and extra
 * work all count, so gym-floor substitutions and bonus sets still show up as
 * training the body received.
 */
function WeekVolumePanel({ volume, inProgress }: { volume: WeekActualVolume; inProgress: boolean }) {
  if (volume.byMuscle.length === 0) return null;
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title={`Week ${volume.week} — trained volume`}
        meta={
          inProgress
            ? "week in progress · counts every working set: planned, swapped, extra"
            : "counts every working set: planned, swapped, extra"
        }
        icon={<BarChart3 className="size-4" />}
        right={<span className="tabular text-xs text-muted">{volume.totalSets} working sets</span>}
      />
      <div className="divide-y divide-border-soft/70">
        {volume.byMuscle.map((m) => (
          <MuscleVolumeRow key={m.muscle} m={m} />
        ))}
      </div>
      {volume.unmappedSets > 0 && (
        <div className="border-t border-border-soft bg-surface-2/35 px-4 py-2 text-xs text-faint">
          +{volume.unmappedSets} working set{volume.unmappedSets === 1 ? "" : "s"} on lifts without a
          mapped muscle group.
        </div>
      )}
    </Panel>
  );
}

function MuscleVolumeRow({ m }: { m: MuscleActualVolume }) {
  const meta = VERDICT_META[m.verdict];
  const mixed = m.fromSwaps > 0 || m.fromExtras > 0;
  const parts = [
    m.fromPlanned > 0 ? `${m.fromPlanned} planned` : null,
    m.fromSwaps > 0 ? `${m.fromSwaps} swapped` : null,
    m.fromExtras > 0 ? `${m.fromExtras} extra` : null,
  ].filter(Boolean);
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-medium text-ink">{m.muscle}</span>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>
      <div className="text-right">
        <div className="tabular text-muted">
          {m.sets} done · {m.plannedSets} planned
        </div>
        {mixed && <div className="text-[0.6875rem] text-faint">{parts.join(" · ")}</div>}
      </div>
    </div>
  );
}

function statusBadge(row: WorkoutExerciseImpact) {
  if (row.status === "skipped") return <Badge tone="warning">skipped</Badge>;
  if (row.status === "swapped") return <Badge tone="info">swapped</Badge>;
  return <Badge tone={verdictTone(row.verdict)}>{row.verdict}</Badge>;
}

function templateLine(row: WorkoutExerciseImpact) {
  if (!row.templateTitle) return null;
  return row.status === "swapped" ? `did: ${row.templateTitle}` : row.templateTitle;
}

function DesktopRow({ row, unit }: { row: WorkoutExerciseImpact; unit: string }) {
  return (
    <tr className="border-t border-border-soft/70 align-top transition-colors hover:bg-surface-2/40">
      <td className="px-4 py-3">
        <div className="font-medium text-ink">{row.exercise.name}</div>
        {row.templateTitle && (
          <div className="mt-0.5 text-[0.6875rem] text-faint">{templateLine(row)}</div>
        )}
      </td>
      <td className="px-2 py-3 text-muted">{planText(row, unit)}</td>
      <td className="px-2 py-3">{setChips(row, unit)}</td>
      <td className="px-2 py-3">{statusBadge(row)}</td>
      <td className="px-4 py-3">
        <NextWeek row={row} unit={unit} />
      </td>
    </tr>
  );
}

function MobileRow({ row, unit }: { row: WorkoutExerciseImpact; unit: string }) {
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium leading-snug text-ink">{row.exercise.name}</div>
          {row.templateTitle && (
            <div className="mt-0.5 text-[0.6875rem] text-faint">{templateLine(row)}</div>
          )}
        </div>
        {statusBadge(row)}
      </div>
      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <Metric label="Plan" value={planText(row, unit)} />
        <div>
          <div className="mb-1 text-[0.625rem] uppercase tracking-wide text-faint">Did</div>
          {setChips(row, unit)}
        </div>
        <div>
          <div className="mb-1 text-[0.625rem] uppercase tracking-wide text-faint">Next week</div>
          <NextWeek row={row} unit={unit} />
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-[0.625rem] uppercase tracking-wide text-faint">{label}</div>
      <div className="tabular text-muted">{value}</div>
    </div>
  );
}

function NextWeek({ row, unit }: { row: WorkoutExerciseImpact; unit: string }) {
  if (!row.change || !row.nextPrescription) {
    return <div className="text-xs text-faint">{row.decisionNote}</div>;
  }
  return (
    <div className="space-y-1">
      <div className="tabular text-muted">
        {changeText(row, unit)}
        <span className="mx-1.5 text-faint">·</span>
        {loadText(row.nextPrescription.load, unit, row.exercise.perHand)} × {row.nextPrescription.reps}
      </div>
      <div className="text-xs leading-relaxed text-faint">{row.decisionNote}</div>
    </div>
  );
}

function setChips(row: WorkoutExerciseImpact, unit: string) {
  if (row.actualSets.length === 0) return <span className="text-xs text-faint">No sets</span>;
  // A substitute is a different movement — never inherit the planned lift's
  // per-hand display for its weights.
  const perHand = row.status === "swapped" ? false : row.exercise.perHand;
  return (
    <div className="flex flex-wrap gap-1.5">
      {row.actualSets.map((set, i) => (
        <span
          key={i}
          className={`tabular rounded-md border px-1.5 py-0.5 text-xs ${
            set.type === "warmup"
              ? "border-info/25 bg-info/8 text-ink"
              : "border-border-soft bg-surface-2 text-muted"
          }`}
        >
          {set.type === "warmup" && (
            <span className="mr-1 text-[0.5625rem] font-medium uppercase tracking-wide text-info">WU</span>
          )}
          {set.weight == null ? "BW" : loadText(set.weight, unit, perHand)}
          ×{set.reps}
          {set.rpe != null ? `@${set.rpe}` : set.type === "warmup" ? "" : "@?"}
        </span>
      ))}
    </div>
  );
}

function planText(row: WorkoutExerciseImpact, unit: string) {
  const warmup = row.prescription.warmupSets.length
    ? `WU ${row.prescription.warmupSets.map((set) => `${loadText(set.load, unit, row.exercise.perHand)}×${set.reps}`).join(" → ")} · `
    : "";
  return `${warmup}${loadText(row.prescription.load, unit, row.exercise.perHand)} × ${row.prescription.reps} × ${row.prescription.sets} @RPE ${rpeFromRir(row.prescription.rirCutoff)}`;
}

function changeText(row: WorkoutExerciseImpact, unit: string) {
  const change = row.change;
  if (!change || change.field === "hold" || change.from == null || change.to == null) return "hold";
  if (change.field === "e1rm") return `e1RM ${change.from} → ${change.to}`;
  return `${change.from} → ${loadText(change.to, unit, row.exercise.perHand)}`;
}

function loadText(value: number, unit: string, perHand?: boolean) {
  if (value === 0) return "BW";
  return `${value} ${unit}${perHand ? " / hand" : ""}`;
}

function verdictTone(verdict: WorkoutVerdict) {
  if (verdict === "above") return "success";
  if (verdict === "below") return "warning";
  return "default";
}

function summaryText(impact: WorkoutImpact) {
  return `${impact.summary.above} above · ${impact.summary.on} on · ${impact.summary.below} below`;
}

function extrasText(extras: WorkoutExtraImpact[], unit: string) {
  return extras
    .map((extra) => {
      const first = extra.actualSets[0];
      const top = first ? ` (${first.weight == null ? "BW" : loadText(first.weight, unit)} × ${first.reps})` : "";
      const muscle = extra.muscle ? ` · ${extra.muscle}` : "";
      return `${extra.title}${top}${muscle}`;
    })
    .join(", ");
}

function rpeFromRir(rir: number) {
  return Math.round((10 - rir) * 10) / 10;
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}
