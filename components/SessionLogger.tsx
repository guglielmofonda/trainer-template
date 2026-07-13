"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ArrowRight, Check } from "lucide-react";
import type { Exercise, WeekPlan, LoggedSet } from "@/lib/engine/types";
import { prescribe } from "@/lib/engine/prescription";
import { RULE_META } from "@/lib/engine/rules";
import { logSession } from "@/app/actions";
import { Badge, Button } from "@/components/ui";

interface Item {
  exercise: Exercise;
  plan: WeekPlan;
}

export function SessionLogger({
  dayId,
  week,
  unit,
  items,
}: {
  dayId: string;
  week: number;
  unit: string;
  items: Item[];
}) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <ExerciseCard key={item.exercise.id} dayId={dayId} week={week} unit={unit} {...item} />
      ))}
    </div>
  );
}

function ExerciseCard({
  dayId,
  week,
  unit,
  exercise,
  plan,
}: Item & { dayId: string; week: number; unit: string }) {
  const [open, setOpen] = useState(false);
  const [single, setSingle] = useState<{ weight: string; rpe: string }>({
    weight: "",
    rpe: String(exercise.openingSingleRpe),
  });
  const [result, setResult] = useState<{
    decision: { note: string };
    nextPreview: { load: number; reps: number; sets: number };
  } | null>(null);
  const [pending, setPending] = useState(false);
  const displayUnit = loadUnit(unit, exercise.perHand);
  const inputUnit = compactLoadUnit(unit, exercise.perHand);

  // Live prescription: recompute from the opening single as the athlete types.
  const openingSingle =
    single.weight && Number(single.weight) > 0
      ? { weight: Number(single.weight), rpe: Number(single.rpe) || exercise.openingSingleRpe }
      : undefined;
  const rx = useMemo(
    () => prescribe(exercise, plan, openingSingle ? { openingSingle } : {}),
    [exercise, plan, single.weight, single.rpe], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Work-set rows, prefilled to the prescription.
  const [sets, setSets] = useState<LoggedSet[]>(
    Array.from({ length: plan.sets }, () => ({ weight: rx.load, reps: plan.reps, rpe: 10 - plan.rir })),
  );
  // keep prefilled weight in sync with the live prescription until edited
  const [touchedSets, setTouchedSets] = useState(false);
  const effectiveSets = touchedSets
    ? sets
    : sets.map((s) => ({ ...s, weight: rx.load, reps: plan.reps }));

  async function submit() {
    setPending(true);
    try {
      const used = effectiveSets.filter((s) => s.weight > 0 && s.reps > 0);
      const res = await logSession({
        dayId,
        exerciseId: exercise.id,
        week,
        date: new Date().toISOString(),
        openingSingle,
        sets: used,
        setsCompleted: used.length,
      });
      setResult({ decision: { note: res.decision.note }, nextPreview: res.nextPreview });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-soft bg-surface transition-colors">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/40"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium leading-snug">{exercise.name}</span>
            {exercise.compound && (
              <Badge tone="default">compound</Badge>
            )}
            {rx.warmupSets.length > 0 && (
              <Badge tone="info">{rx.warmupSets.length} warm-up sets</Badge>
            )}
          </div>
          <div className="mt-0.5 text-[0.6875rem] text-muted">
            {RULE_META[exercise.rule].name} · {exercise.muscle}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <div className="tabular text-sm">
              {loadLabel(rx.load, displayUnit)} × {rx.reps}
            </div>
            <div className="tabular text-[0.625rem] text-faint">
              {plan.sets} sets @ {rx.rirCutoff} RIR
            </div>
          </div>
          <ChevronDown
            className={`size-4 text-faint transition-transform duration-[var(--dur)] ease-out ${open ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border-soft px-4 pb-4 pt-3.5">
          {rx.warmupSets.length > 0 && (
            <div>
              <div className="mb-1.5 text-[0.625rem] font-medium uppercase tracking-wide text-faint">
                Warm-up sets — marked, not working volume
              </div>
              <div className="flex flex-wrap gap-1.5">
                {rx.warmupSets.map((warmup, i) => (
                  <span
                    key={`${warmup.load}-${warmup.reps}-${i}`}
                    className="tabular rounded-md border border-info/25 bg-info/8 px-2 py-1 text-xs text-ink"
                  >
                    <span className="mr-1 text-[0.625rem] font-medium uppercase tracking-wide text-info">WU</span>
                    {loadLabel(warmup.load, displayUnit)} × {warmup.reps}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[0.6875rem] text-muted">
                Keep every rep fast and easy. Rest only long enough to feel ready for the next jump.
              </p>
            </div>
          )}

          {/* Opening single */}
          {exercise.usesOpeningSingle && (
            <div>
              <div className="mb-1.5 text-[0.625rem] font-medium uppercase tracking-wide text-faint">
                Opening single @{exercise.openingSingleRpe} — calibrates today's e1RM
              </div>
              <div className="flex flex-wrap items-end gap-2.5">
                <LabeledInput
                  label="Weight"
                  value={single.weight}
                  onChange={(v) => setSingle((s) => ({ ...s, weight: v }))}
                  placeholder={String(rx.openingSingle?.weight ?? "")}
                  suffix={inputUnit}
                />
                <LabeledInput
                  label="Actual RPE"
                  value={single.rpe}
                  onChange={(v) => setSingle((s) => ({ ...s, rpe: v }))}
                />
                <div className="min-w-full flex-1 pb-1.5 text-[0.6875rem] text-muted sm:min-w-0">
                  {openingSingle ? (
                    <>
                      e1RM{" "}
                      <span key={rx.basisE1rm} className="tabular anim-flash font-medium text-accent">
                        {rx.basisE1rm}
                      </span>{" "}
                      → work sets re-scaled
                    </>
                  ) : (
                    <>
                      Suggested ≈{" "}
                      <span className="tabular">
                        {rx.openingSingle?.weight}@{rx.openingSingle?.rpe}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Prescription */}
          <div className="rounded-md border border-border-soft bg-surface-2 px-3.5 py-3">
            <div className="mb-1 text-[0.625rem] font-medium uppercase tracking-wide text-faint">
              Prescription
            </div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="tabular text-[1.5rem] font-medium leading-none">
                <span key={rx.load} className="anim-flash">
                  {loadLabel(rx.load, displayUnit)}
                </span>
                <span className="mx-1.5 text-faint">×</span>
                {rx.reps}
              </span>
              <span className="text-xs text-muted">
                stop at {rx.rirCutoff} RIR · cap {plan.sets} sets
              </span>
            </div>
          </div>

          {/* Work sets */}
          <div>
            <div className="mb-2 text-[0.625rem] font-medium uppercase tracking-wide text-faint">
              Work sets
            </div>
            <div className="space-y-1.5">
              {effectiveSets.map((s, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1.25rem_minmax(4.25rem,1.15fr)_auto_minmax(3.5rem,0.85fr)_auto_minmax(3.5rem,0.85fr)] items-center gap-1.5 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-2"
                >
                  <span className="tabular w-5 text-[0.6875rem] text-faint">{i + 1}</span>
                  <SetInput value={s.weight} onChange={(v) => updateSet(i, "weight", v)} suffix={inputUnit} />
                  <span className="text-faint">×</span>
                  <SetInput value={s.reps} onChange={(v) => updateSet(i, "reps", v)} suffix="reps" />
                  <span className="text-faint">@</span>
                  <SetInput value={s.rpe} onChange={(v) => updateSet(i, "rpe", v)} suffix="RPE" step={0.5} />
                </div>
              ))}
            </div>
          </div>

          <Button variant="primary" size="md" onClick={submit} disabled={pending} className="w-full">
            {pending ? (
              "Logging…"
            ) : (
              <>
                Log &amp; compute next week
                <ArrowRight className="size-4" />
              </>
            )}
          </Button>

          {result && (
            <div
              role="status"
              aria-live="polite"
              className="anim-fade-up space-y-1.5 rounded-md border border-success/30 bg-success/8 px-3.5 py-3"
            >
              <div className="flex items-start gap-2 text-[0.8125rem] text-ink">
                <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
                <span>{result.decision.note}</span>
              </div>
              <div className="pl-5 text-[0.6875rem] text-muted">
                Next week ≈{" "}
                <span className="tabular font-medium text-success">
                  {result.nextPreview.load} × {result.nextPreview.reps}
                </span>{" "}
                for {result.nextPreview.sets} sets
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  function updateSet(i: number, key: keyof LoggedSet, raw: string) {
    setTouchedSets(true);
    const base = touchedSets ? sets : effectiveSets;
    const next = base.map((s, idx) => (idx === i ? { ...s, [key]: Number(raw) || 0 } : s));
    setSets(next);
  }
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  suffix?: string;
}) {
  return (
    <label className="flex min-w-[7rem] flex-1 flex-col gap-1 sm:flex-none">
      <span className="text-[0.625rem] text-faint">{label}</span>
      <div className="relative">
        <input
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={`tabular w-full rounded-md border border-border-soft bg-surface-2 px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-faint focus:border-accent sm:w-24 ${
            suffix && suffix.length > 4 ? "pr-14" : suffix ? "pr-9" : ""
          }`}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[0.5625rem] text-faint">
            {suffix}
          </span>
        )}
      </div>
    </label>
  );
}

function SetInput({
  value,
  onChange,
  suffix,
  step,
}: {
  value: number;
  onChange: (v: string) => void;
  suffix: string;
  step?: number;
}) {
  return (
    <div className="relative flex-1">
      <input
        inputMode="decimal"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`tabular w-full rounded-md border border-border-soft bg-surface-2 px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-accent ${
          suffix.length > 4 ? "pr-14" : "pr-7 sm:pr-10"
        }`}
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[0.5625rem] text-faint">
        {suffix}
      </span>
    </div>
  );
}

function loadUnit(unit: string, perHand?: boolean) {
  return perHand ? `${unit} / hand` : unit;
}

function compactLoadUnit(unit: string, perHand?: boolean) {
  return perHand ? `${unit}/hand` : unit;
}

function loadLabel(load: number, unit: string) {
  if (load === 0) return "BW";
  return `${load} ${unit}`;
}
