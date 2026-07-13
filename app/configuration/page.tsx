import { getStore } from "@/lib/store/fileStore";
import { buildCalendar } from "@/lib/engine/calendar";
import { periodizationTable } from "@/lib/engine/periodization";
import { planningCheck } from "@/lib/engine/analysis";
import { RULE_META } from "@/lib/engine/rules";
import {
  PageHeader,
  Panel,
  PanelHeader,
  Badge,
  Readout,
  VolumeBar,
  compositionShades,
} from "@/components/ui";
import { PushToGitHub } from "@/components/PushToGitHub";
import { AlertTriangle, CircleCheck, Lock, Unlock } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ConfigurationPage() {
  const program = await getStore().getProgram();
  const savesAutomatically = Boolean(
    process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID,
  );
  const calendar = buildCalendar(program.cycle);
  const check = planningCheck(program, 1);

  // Periodization preview for the primary compound (first exercise).
  const primary = program.days[0].exercises[0];
  const table = periodizationTable(primary.wave, calendar);

  const totalExercises = program.days.reduce((n, d) => n + d.exercises.length, 0);
  const trainingWeeks = calendar.filter((w) => !w.isDeload).length;

  // The block's structural spec (what it IS) is chrome; the engine's week-1 output
  // (what it PRODUCES) is the hero. Different weight — not five identical tiles.
  const spec = [
    {
      label: "Cycle",
      value: calendar.length,
      unit: "wk",
      note: `${trainingWeeks} training · ${calendar.length - trainingWeeks} deload`,
    },
    {
      label: "Schedule",
      value: program.days.length,
      unit: "days/wk",
      note: `${program.cycle.weeksOn} on · ${program.cycle.weeksOff} off × ${program.cycle.mesocycles}`,
    },
    { label: "Exercises", value: totalExercises, unit: "slots", note: "across the split" },
  ];

  // Composition reads as a ranked contribution, largest share first.
  const composition = [...check.byMuscle].sort((a, b) => b.share - a.share);
  const shades = compositionShades(composition.length);

  return (
    <div className="pb-10">
      <PageHeader
        title="Configuration"
        sub="Your cycle skeleton, weekly volume graded against evidence-based landmarks, and the periodization wave that drives every prescription."
        right={
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {program.locked ? (
              <Badge tone="default">
                <Lock className="size-3" /> locked
              </Badge>
            ) : (
              <Badge tone="warning">
                <Unlock className="size-3" /> editable
              </Badge>
            )}
            {savesAutomatically ? (
              <Badge tone="success">
                <CircleCheck className="size-3" /> saved automatically
              </Badge>
            ) : (
              <PushToGitHub />
            )}
          </div>
        }
      />

      <div className="space-y-5 px-5 py-5 sm:px-6">
        {/* Block spec — structural facts (chrome), then the engine's headline output (hero) */}
        <Panel>
          <div className="flex flex-col gap-x-10 gap-y-6 px-4 py-4 lg:flex-row lg:items-center sm:px-5">
            <dl className="flex min-w-0 flex-wrap items-baseline gap-x-8 gap-y-3">
              {spec.map((s) => (
                <div key={s.label} className="flex flex-col gap-1">
                  <dt className="label text-faint">{s.label}</dt>
                  <dd className="tabular text-lg font-medium leading-none text-ink-strong">
                    {s.value}
                    <span className="ml-1 text-xs font-normal text-faint">{s.unit}</span>
                  </dd>
                  <dd className="text-[0.6875rem] text-muted">{s.note}</dd>
                </div>
              ))}
            </dl>

            <div className="hidden h-12 w-px shrink-0 bg-border lg:ml-auto lg:block" />

            <div className="flex items-end gap-8 sm:gap-12">
              <Readout
                label="Working volume"
                value={check.totalSets}
                unit="sets / wk"
                sub="week 1"
                size="lg"
              />
              <Readout
                label="Total reps"
                value={check.totalReps}
                unit="reps / wk"
                sub="week 1"
                size="lg"
              />
            </div>
          </div>
        </Panel>

        {/* Composition — how the weekly set total splits across muscles, ranked */}
        <Panel>
          <PanelHeader
            title="Composition"
            meta="share of weekly sets · largest first"
            right={
              <span className="tabular text-xs text-muted">
                {composition.length} muscle groups
              </span>
            }
          />
          <div className="px-4 py-4 sm:px-5">
            <div className="flex h-2.5 overflow-hidden rounded-[1px] bg-bg ring-1 ring-inset ring-border">
              {composition.map((m, i) => (
                <div
                  key={m.muscle}
                  title={`${m.muscle} · ${m.sets} sets · ${Math.round(m.share * 100)}%`}
                  className="h-full border-r border-bg last:border-r-0"
                  style={{ width: `${m.share * 100}%`, background: shades[i] }}
                />
              ))}
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {composition.map((m, i) => (
                <div key={m.muscle} className="flex items-center gap-2 text-xs">
                  <span
                    className="size-2.5 shrink-0 rounded-[1px]"
                    style={{ background: shades[i] }}
                    aria-hidden="true"
                  />
                  <dt className="flex-1 truncate text-muted">{m.muscle}</dt>
                  <dd className="tabular font-medium text-ink">
                    {Math.round(m.share * 100)}%
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Panel>

        {/* Planning check — weekly sets per muscle vs. MEV/MAV/MRV landmarks */}
        <Panel>
          <PanelHeader
            title="Planning check"
            meta="week 1 · per primary muscle"
            right={
              <span className="tabular text-xs text-muted">
                {check.totalSets} sets · {check.totalReps} reps
              </span>
            }
          />
          <div className="px-4 py-3 sm:px-5">
            <p className="mb-2 max-w-2xl text-xs leading-relaxed text-muted">
              Weekly working sets per muscle vs. MEV–MAV–MRV landmarks (after
              Israetel / Renaissance Periodization). The shaded band is the
              productive (MAV) range; ticks mark MEV and MRV.
            </p>
            <div className="grid grid-cols-1 gap-x-12 md:grid-cols-2">
              {check.byMuscle.map((m) => (
                <VolumeBar key={m.muscle} {...m} />
              ))}
            </div>

            {check.warnings.length > 0 ? (
              <div className="mt-3 space-y-1.5">
                {check.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/8 px-3 py-2 text-xs text-warning"
                  >
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    <span className="text-ink/90">{w}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-2 rounded-md border border-success/25 bg-success/8 px-3 py-2 text-xs text-success">
                <CircleCheck className="size-3.5 shrink-0" />
                <span className="text-ink/90">
                  Every muscle group sits inside its productive range — nothing flagged.
                </span>
              </div>
            )}
          </div>
        </Panel>

        {/* Periodization table */}
        <Panel>
          <PanelHeader
            title={
              <span>
                Periodization wave —{" "}
                <span className="text-ink-strong">{primary.name}</span>
              </span>
            }
            right={<Badge tone="info">{RULE_META[primary.rule].name}</Badge>}
          />
          <div className="px-4 py-3">
            <p className="mb-3 text-xs leading-relaxed text-muted">
              {primary.wave.shape} · reps {primary.wave.repsStart}→{primary.wave.repsEnd}{" "}
              · RIR {primary.wave.rirStart}→{primary.wave.rirEnd} · intensity{" "}
              {primary.wave.intensityStart}×→{primary.wave.intensityEnd}× — each
              micro-wave ramps from easy to a heavy single.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-soft text-left text-[0.6875rem] uppercase tracking-wide text-faint">
                    <th className="py-2 pr-3 font-medium">Week</th>
                    <th className="py-2 pr-3 font-medium">Reps</th>
                    <th className="py-2 pr-3 font-medium">Sets</th>
                    <th className="py-2 pr-3 font-medium">RIR</th>
                    <th className="py-2 pr-3 font-medium">Intensity</th>
                  </tr>
                </thead>
                <tbody>
                  {table.map((row) => (
                    <tr
                      key={row.week}
                      className={`border-b border-border-soft/60 ${row.isDeload ? "text-faint" : ""}`}
                    >
                      <td className="tabular py-2 pr-3">
                        {row.label.replace(" · deload", "")}
                      </td>
                      {row.isDeload ? (
                        <td colSpan={4} className="py-2 pr-3 text-xs italic text-info">
                          deload — {row.sets} sets, light &amp; submaximal
                        </td>
                      ) : (
                        <>
                          <td className="tabular py-2 pr-3">{row.reps}</td>
                          <td className="tabular py-2 pr-3">{row.sets}</td>
                          <td className="tabular py-2 pr-3">{row.rir}</td>
                          <td className="py-2 pr-3">
                            <span className="flex items-center gap-2.5">
                              <span className="relative h-1.5 w-24 overflow-hidden rounded-[1px] bg-surface-2">
                                <span
                                  className="anim-grow-x absolute inset-y-0 left-0 rounded-[1px] bg-ink-strong"
                                  style={{
                                    width: `${Math.min(100, (row.intensity - 0.9) * 200)}%`,
                                  }}
                                />
                              </span>
                              <span className="tabular text-xs text-muted">
                                {row.intensity.toFixed(2)}×
                              </span>
                            </span>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
