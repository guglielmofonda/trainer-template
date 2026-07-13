"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  CircleAlert,
  Scale,
} from "lucide-react";
import type { HevyProgressResult } from "@/app/actions";
import type {
  BodyWeightPoint,
  LiftProgress,
  MajorLiftKey,
  ProgressSnapshot,
} from "@/lib/progress";
import { Badge, PageHeader, Panel, PanelHeader, Readout } from "@/components/ui";

interface ProgressDashboardProps {
  initialResult: HevyProgressResult;
}

export function ProgressDashboard({ initialResult }: ProgressDashboardProps) {
  const snapshot = initialResult.ok ? initialResult.snapshot : null;
  const error = initialResult.ok ? null : initialResult.error;
  const [activeLift, setActiveLift] = useState<MajorLiftKey>(() =>
    firstTrackedLift(snapshot),
  );

  return (
    <div className="pb-10">
      <PageHeader
        title="Progress"
        sub="Major-lift strength trends and bodyweight history, read directly from Hevy."
        right={
          snapshot ? (
            <Badge tone="success" dot>
              Hevy connected
            </Badge>
          ) : (
            <Badge tone="warning" dot>
              Hevy unavailable
            </Badge>
          )
        }
      />

      <div className="space-y-5 px-5 py-5 sm:px-6">
        {error && (
          <Panel>
            <div className="flex items-start gap-3 px-4 py-4">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>
                <div className="font-medium text-ink">Progress could not be loaded</div>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted">{error}</p>
              </div>
            </div>
          </Panel>
        )}

        {snapshot && (
          <>
            <StrengthPanel
              snapshot={snapshot}
              activeLift={activeLift}
              onLiftChange={setActiveLift}
            />
            <BodyWeightPanel snapshot={snapshot} />
            <p className="max-w-4xl text-[0.6875rem] leading-relaxed text-faint">
              Strength uses the best non-warm-up set of 15 reps or fewer in each session.
              Logged RPE drives the estimate when available; otherwise the app uses Epley.
              Body weight comes from Hevy Measurements. This page refreshes automatically when
              opened; data pulled {formatDateTime(snapshot.generatedAt)}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function StrengthPanel({
  snapshot,
  activeLift,
  onLiftChange,
}: {
  snapshot: ProgressSnapshot;
  activeLift: MajorLiftKey;
  onLiftChange: (lift: MajorLiftKey) => void;
}) {
  const lift = snapshot.lifts.find((item) => item.key === activeLift) ?? snapshot.lifts[0];
  const chartPoints = lift.points.map((point) => ({
    date: point.date,
    value: point.estimated1RmLb,
    label: `${point.weightLb} lb × ${point.reps}${point.rpe == null ? "" : ` @${point.rpe}`}`,
  }));

  return (
    <Panel>
      <PanelHeader
        title="Strength progression"
        meta="best working set → estimated 1RM"
        icon={<Activity className="size-4" />}
        right={lift.changeLb != null ? <DeltaBadge value={lift.changeLb} unit="lb" /> : undefined}
      />
      <div className="border-b border-border-soft px-3 py-3">
        <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Major lift">
          {snapshot.lifts.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={item.key === activeLift}
              onClick={() => onLiftChange(item.key)}
              className={`shrink-0 rounded-md px-3 py-1.5 text-[0.8125rem] transition-colors duration-[var(--dur-fast)] ${
                item.key === activeLift
                  ? "bg-surface-3 font-medium text-ink"
                  : "text-muted hover:bg-surface-2 hover:text-ink"
              }`}
            >
              {item.label}
              <span className="tabular ml-1.5 text-[0.6875rem] text-faint">
                {item.points.length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {lift.points.length ? (
        <div className="space-y-5 px-4 py-4">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
            <Readout
              label="Current e1RM"
              value={lift.latest}
              unit="lb"
              size="lg"
              tone="accent"
              sub={`${lift.points.length} logged session${lift.points.length === 1 ? "" : "s"}`}
            />
            <Readout label="Best" value={lift.best} unit="lb" size="sm" />
            <Readout
              label="Change"
              value={signed(lift.changeLb)}
              unit="lb"
              size="sm"
              tone={lift.changeLb != null && lift.changeLb > 0 ? "success" : "ink"}
              sub={lift.changePercent == null ? "need 2 sessions" : `${signed(lift.changePercent, 1)}%`}
            />
          </div>

          <LineChart
            points={chartPoints}
            unit="lb"
            ariaLabel={`${lift.label} estimated one-rep max progression in pounds`}
            tone="accent"
          />

          <div className="overflow-x-auto rounded-md border border-border-soft">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border-soft text-left text-[0.6875rem] uppercase tracking-wide text-faint">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Workout</th>
                  <th className="px-3 py-2 text-right font-medium">Top set</th>
                  <th className="px-3 py-2 text-right font-medium">e1RM</th>
                </tr>
              </thead>
              <tbody>
                {[...lift.points].reverse().slice(0, 8).map((point) => (
                  <tr key={`${point.workoutId}-${point.date}`} className="border-b border-border-soft/60 last:border-0">
                    <td className="tabular whitespace-nowrap px-3 py-2 text-muted">{formatDate(point.date)}</td>
                    <td className="max-w-64 truncate px-3 py-2">{point.workoutTitle}</td>
                    <td className="tabular whitespace-nowrap px-3 py-2 text-right">
                      {point.weightLb} × {point.reps}
                      {point.rpe != null && <span className="text-faint"> @{point.rpe}</span>}
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2 text-right text-ink-strong">
                      {point.estimated1RmLb} lb
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyState>
          No {lift.label.toLowerCase()} sessions were found in the last year. New sessions
          logged in Hevy will appear here automatically.
        </EmptyState>
      )}
    </Panel>
  );
}

function BodyWeightPanel({ snapshot }: { snapshot: ProgressSnapshot }) {
  const progress = snapshot.bodyWeight;
  const chartPoints = progress.points.map((point) => ({
    date: point.date,
    value: point.weightLb,
    label: `${point.weightLb} lb`,
  }));

  return (
    <Panel>
      <PanelHeader
        title="Bodyweight progression"
        meta="Hevy Measurements"
        icon={<Scale className="size-4" />}
        right={progress.changeLb != null ? <DeltaBadge value={progress.changeLb} unit="lb" neutral /> : undefined}
      />
      {progress.points.length ? (
        <div className="space-y-5 px-4 py-4">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
            <Readout label="Latest" value={progress.latest} unit="lb" size="lg" />
            <Readout label="Range low" value={progress.low} unit="lb" size="sm" />
            <Readout label="Range high" value={progress.high} unit="lb" size="sm" />
            <Readout
              label="Change"
              value={signed(progress.changeLb, 1)}
              unit="lb"
              size="sm"
              tone="ink"
              sub={`${progress.points.length} measurement${progress.points.length === 1 ? "" : "s"}`}
            />
          </div>
          <LineChart
            points={chartPoints}
            unit="lb"
            ariaLabel="Bodyweight progression in pounds"
            tone="info"
          />
        </div>
      ) : (
        <EmptyState>
          No bodyweight measurements were found in the last year. New entries under
          Measurements in Hevy will appear here automatically.
        </EmptyState>
      )}
    </Panel>
  );
}

function LineChart({
  points,
  unit,
  ariaLabel,
  tone,
}: {
  points: Array<{ date: string; value: number; label: string }>;
  unit: string;
  ariaLabel: string;
  tone: "accent" | "info";
}) {
  const chart = useMemo(() => chartGeometry(points), [points]);
  const stroke = tone === "info" ? "var(--color-info)" : "var(--color-accent)";

  return (
    <div className="overflow-hidden rounded-[2px] bg-surface px-2 py-3 ring-1 ring-inset ring-border">
      <svg
        viewBox="0 0 720 240"
        className="h-56 w-full"
        role="img"
        aria-label={ariaLabel}
      >
        {chart.yTicks.map((tick) => (
          <g key={tick.value}>
            <line
              x1="48"
              x2="704"
              y1={tick.y}
              y2={tick.y}
              stroke="var(--color-border-soft)"
              strokeWidth="1"
            />
            <text
              x="40"
              y={tick.y + 4}
              textAnchor="end"
              fill="var(--color-faint)"
              fontFamily="var(--font-geist-mono), monospace"
              fontSize="10"
            >
              {tick.value}
            </text>
          </g>
        ))}
        {chart.path && (
          <polyline
            points={chart.path}
            fill="none"
            stroke={stroke}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {chart.points.map((point) => (
          <g key={`${point.date}-${point.value}`}>
            <circle
              cx={point.x}
              cy={point.y}
              r="4"
              fill="var(--color-surface)"
              stroke={stroke}
              strokeWidth="2"
            >
              <title>{`${formatDate(point.date)} · ${point.label}`}</title>
            </circle>
          </g>
        ))}
        {chart.xLabels.map((point, index) => (
          <text
            key={`${point.date}-${index}`}
            x={point.x}
            y="229"
            textAnchor={index === 0 ? "start" : index === chart.xLabels.length - 1 ? "end" : "middle"}
            fill="var(--color-faint)"
            fontFamily="var(--font-geist-mono), monospace"
            fontSize="10"
          >
            {formatShortDate(point.date)}
          </text>
        ))}
        <text
          x="704"
          y="18"
          textAnchor="end"
          fill="var(--color-faint)"
          fontFamily="var(--font-geist-mono), monospace"
          fontSize="10"
        >
          {unit}
        </text>
      </svg>
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead><tr><th>Date</th><th>Value</th></tr></thead>
        <tbody>
          {points.map((point) => <tr key={`${point.date}-${point.value}`}><td>{point.date}</td><td>{point.value} {unit}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

function chartGeometry(points: Array<{ date: string; value: number; label: string }>) {
  const width = 656;
  const height = 184;
  const left = 48;
  const top = 22;
  const values = points.map((point) => point.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = Math.max(rawMax - rawMin, Math.max(rawMax * 0.04, 5));
  const min = Math.floor((rawMin - span * 0.15) / 5) * 5;
  const max = Math.ceil((rawMax + span * 0.15) / 5) * 5;
  const start = Math.min(...points.map((point) => Date.parse(point.date)));
  const end = Math.max(...points.map((point) => Date.parse(point.date)));

  const plotted = points.map((point, index) => {
    const time = Date.parse(point.date);
    const x = start === end ? left + width / 2 : left + ((time - start) / (end - start)) * width;
    const y = top + height - ((point.value - min) / Math.max(1, max - min)) * height;
    return { ...point, x, y, index };
  });
  const labelIndexes = [...new Set([0, Math.round((points.length - 1) / 3), Math.round(((points.length - 1) * 2) / 3), points.length - 1])];

  return {
    points: plotted,
    path: plotted.length > 1 ? plotted.map((point) => `${point.x},${point.y}`).join(" ") : "",
    xLabels: labelIndexes.map((index) => plotted[index]).filter(Boolean),
    yTicks: [0, 1, 2, 3].map((index) => {
      const fraction = index / 3;
      return {
        value: Math.round(max - fraction * (max - min)),
        y: top + fraction * height,
      };
    }),
  };
}

function DeltaBadge({ value, unit, neutral = false }: { value: number; unit: string; neutral?: boolean }) {
  const positive = value > 0;
  const negative = value < 0;
  const Icon = positive ? ArrowUpRight : negative ? ArrowDownRight : Activity;
  return (
    <Badge tone={neutral ? "default" : positive ? "success" : negative ? "warning" : "default"}>
      <Icon className="size-3" />
      <span className="tabular">{signed(value, 1)} {unit}</span>
    </Badge>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-36 items-center justify-center px-5 py-8 text-center">
      <p className="max-w-xl text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function firstTrackedLift(snapshot: ProgressSnapshot | null): MajorLiftKey {
  return snapshot?.lifts.find((lift) => lift.points.length)?.key ?? "squat";
}

function signed(value: number | null, digits = 0): string {
  if (value == null) return "—";
  const formatted = value.toFixed(digits);
  return value > 0 ? `+${formatted}` : formatted;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const SHORT_DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function formatDate(date: string): string {
  return DAY_FORMAT.format(displayDate(date));
}

function formatShortDate(date: string): string {
  return SHORT_DAY_FORMAT.format(displayDate(date));
}

function formatDateTime(date: string): string {
  return DATE_TIME_FORMAT.format(new Date(date));
}

function displayDate(date: string): Date {
  // Hevy body measurements are calendar dates, not UTC instants. Noon local
  // prevents YYYY-MM-DD from rolling back a day in western time zones.
  return /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T12:00:00`)
    : new Date(date);
}
