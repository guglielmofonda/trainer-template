import React from "react";
import Link from "next/link";

/* ============================================================================
   Trainer design system — "Ledger"
   Editorial strength instrument: hairline rules, sharp corners, serif display
   voice + tabular mono for every number. Chrome is monochrome; color is
   reserved for data meaning. Server-component safe (no hooks). See DESIGN.md.
   ========================================================================= */

/** The brand mark: the athlete monogram (from data/profile.json) with a loading bar. */
export function BrandMark({
  className = "",
  monogram = "Tr",
}: {
  className?: string;
  monogram?: string;
}) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <text
        x="16"
        y="20.5"
        textAnchor="middle"
        fontFamily="var(--font-serif-display), Georgia, serif"
        fontSize="15"
        fontWeight="600"
        fill="currentColor"
      >
        {monogram}
      </text>
      <path
        d="M8 25h16"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="butt"
        opacity={0.65}
      />
    </svg>
  );
}

export function PageHeader({
  title,
  sub,
  right,
}: {
  title: string;
  sub?: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="relative z-[200] border-b border-border bg-bg px-4 py-4 sm:px-6 md:sticky md:top-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
        <div className="min-w-0">
          <h1 className="display text-[1.55rem] leading-[1.05] text-ink-strong text-balance">
            {title}
          </h1>
          {sub && (
            <p className="mt-1.5 max-w-2xl text-[0.8125rem] leading-snug text-muted text-pretty">
              {sub}
            </p>
          )}
        </div>
        {right && (
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end sm:pt-1">
            {right}
          </div>
        )}
      </div>
    </header>
  );
}

export function Panel({
  children,
  className = "",
  lit = false,
}: {
  children: React.ReactNode;
  className?: string;
  lit?: boolean;
}) {
  // `lit` retained for API compatibility; the editorial system is flat (no glow).
  void lit;
  return (
    <div className={`rounded-[2px] border border-border bg-bg ${className}`}>
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  meta,
  right,
  icon,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  right?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <span className="shrink-0 text-muted">{icon}</span>}
        <h2 className="truncate text-[0.9375rem] font-semibold tracking-tight text-ink-strong">
          {title}
        </h2>
        {meta && <span className="hidden truncate text-xs text-faint sm:inline">{meta}</span>}
      </div>
      {right && <div className="shrink-0 sm:ml-auto">{right}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- Badge --- */

export type Tone =
  | "default"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

/** Tone is carried by a small square mark, not by text color — so the label
    stays high-contrast ink and color is never the only signal. */
const TONE_MARK: Record<Tone, string> = {
  default: "bg-faint",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

export function Badge({
  children,
  tone = "default",
  dot = false,
  className = "",
}: {
  children: React.ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  const showMark = dot || tone !== "default";
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[1px] border border-border px-1.5 py-[3px] text-[0.625rem] font-semibold uppercase leading-none tracking-[0.07em] text-ink ${className}`}
    >
      {showMark && (
        <span
          className={`size-[7px] shrink-0 rounded-[0.5px] ${TONE_MARK[tone]}`}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

/* Back-compat alias for the old name. */
export const Chip = Badge;

/* --------------------------------------------------------------- Button --- */

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "sm" | "md";

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-ink-strong text-bg font-semibold hover:bg-ink active:brightness-110",
  secondary:
    "bg-bg text-ink border border-border hover:bg-surface hover:border-border-strong",
  ghost: "text-muted hover:text-ink hover:bg-surface",
};

const BTN_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[0.8125rem] rounded-[2px] gap-1.5",
  md: "h-10 px-4 text-sm rounded-[2px] gap-2",
};

export function Button({
  children,
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center whitespace-nowrap transition-colors duration-[var(--dur-fast)] ease-out disabled:cursor-not-allowed disabled:opacity-45 ${BTN_VARIANT[variant]} ${BTN_SIZE[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------- Readout --- */

/** The signature component: a large tabular-mono value with a label + unit. */
export function Readout({
  label,
  value,
  unit,
  sub,
  size = "md",
  tone = "ink",
  className = "",
}: {
  label?: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  sub?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  tone?: "ink" | "accent" | "success" | "danger";
  className?: string;
}) {
  const valueSize =
    size === "lg" ? "text-[1.875rem]" : size === "md" ? "text-xl" : "text-base";
  const toneClass =
    tone === "accent"
      ? "text-accent"
      : tone === "success"
        ? "text-success"
        : tone === "danger"
          ? "text-danger"
          : "text-ink-strong";
  return (
    <div className={className}>
      {label && <div className="label mb-1.5 text-faint">{label}</div>}
      <div className={`tabular font-medium leading-none ${valueSize} ${toneClass}`}>
        {value}
        {unit && (
          <span className="ml-1 text-[0.5em] font-normal tracking-normal text-faint">
            {unit}
          </span>
        )}
      </div>
      {sub && <div className="mt-2 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------- Week rail / day tabs --- */

interface RailWeek {
  week: number;
  isDeload: boolean;
}

/** Horizontal, scrollable rail of week chips (Program / Session). */
export function WeekRail({
  weeks,
  active,
  href,
}: {
  weeks: RailWeek[];
  active: number;
  href: (week: number) => string;
}) {
  return (
    <div
      className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
      role="tablist"
      aria-label="Training week"
    >
      {weeks.map((w) => {
        const isActive = w.week === active;
        return (
          <Link
            key={w.week}
            href={href(w.week)}
            role="tab"
            aria-selected={isActive}
            title={w.isDeload ? `Week ${w.week} — deload` : `Week ${w.week}`}
            className={`tabular shrink-0 rounded-[2px] px-2.5 py-1.5 text-xs transition-colors duration-[var(--dur-fast)] ease-out ${
              isActive
                ? "bg-ink-strong font-semibold text-bg"
                : w.isDeload
                  ? "text-info hover:bg-surface"
                  : "text-muted hover:bg-surface hover:text-ink"
            }`}
          >
            W{w.week}
          </Link>
        );
      })}
    </div>
  );
}

interface DayTab {
  id: string;
  name: string;
}

/** Segmented day selector (Session). */
export function DayTabs({
  days,
  active,
  href,
}: {
  days: DayTab[];
  active: string;
  href: (id: string) => string;
}) {
  return (
    <div
      className="flex max-w-full gap-1 overflow-x-auto rounded-[2px] border border-border bg-bg p-1"
      role="tablist"
      aria-label="Training day"
    >
      {days.map((d) => {
        const isActive = d.id === active;
        return (
          <Link
            key={d.id}
            href={href(d.id)}
            role="tab"
            aria-selected={isActive}
            className={`shrink-0 rounded-[1px] px-3 py-1.5 text-[0.8125rem] font-medium transition-colors duration-[var(--dur-fast)] ease-out ${
              isActive
                ? "bg-ink-strong text-bg"
                : "text-muted hover:bg-surface hover:text-ink"
            }`}
          >
            {d.name}
          </Link>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ VolumeBar --- */

export type VolumeVerdict =
  | "under"
  | "maintenance"
  | "productive"
  | "high"
  | "over";

export const VERDICT_META: Record<
  VolumeVerdict,
  { label: string; tone: Tone; color: string }
> = {
  under: { label: "Under MEV", tone: "danger", color: "var(--color-danger)" },
  maintenance: { label: "Maintenance", tone: "info", color: "var(--color-info)" },
  productive: { label: "Productive", tone: "success", color: "var(--color-success)" },
  high: { label: "Running hot", tone: "warning", color: "var(--color-warning)" },
  over: { label: "Over MRV", tone: "danger", color: "var(--color-danger)" },
};

/**
 * Composition shading — a single ink lightness ramp (grayscale), not a
 * categorical rainbow. "Share of weekly sets" is proportion data: darkest =
 * largest contributor, fading to light gray. Apply shades in rank order.
 */
export function compositionShades(n: number): string[] {
  if (n <= 1) return ["var(--color-ink)"];
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1); // 0 = largest share (dark ink) → 1 = smallest (mid gray)
    const l = 0.3 + t * 0.42;
    return `oklch(${l.toFixed(3)} 0.006 262)`;
  });
}

/** A volume bar comparing achieved sets against MEV / MAV / MRV landmarks. */
export function VolumeBar({
  muscle,
  sets,
  share,
  verdict,
  landmark,
}: {
  muscle: string;
  sets: number;
  share: number;
  verdict: string;
  landmark: { mev: number; mavLow: number; mavHigh: number; mrv: number };
}) {
  const meta = VERDICT_META[verdict as VolumeVerdict] ?? VERDICT_META.productive;
  const scale = Math.max(landmark.mrv * 1.18, sets * 1.1, 1);
  const pct = (n: number) => `${Math.min(100, (n / scale) * 100)}%`;

  return (
    <div className="py-2.5">
      <div className="mb-2 flex items-center justify-between gap-2 text-[0.8125rem]">
        <span className="flex items-center gap-2 font-medium text-ink-strong">
          {muscle}
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </span>
        <span className="tabular text-muted">
          {sets} sets · {Math.round(share * 100)}%
        </span>
      </div>
      <div
        className="relative h-2 rounded-[1px] bg-surface-2"
        role="img"
        aria-label={`${muscle}: ${sets} sets, ${meta.label}. MEV ${landmark.mev}, MAV ${landmark.mavLow} to ${landmark.mavHigh}, MRV ${landmark.mrv}.`}
      >
        {/* MAV productive band */}
        <div
          className="absolute top-0 h-full bg-ink/[0.1]"
          style={{
            left: pct(landmark.mavLow),
            width: `calc(${pct(landmark.mavHigh)} - ${pct(landmark.mavLow)})`,
          }}
        />
        {/* achieved fill */}
        <div
          className="anim-grow-x absolute top-0 h-full rounded-[1px]"
          style={{ width: pct(sets), background: meta.color }}
        />
        <Tick at={pct(landmark.mev)} title={`MEV ${landmark.mev}`} />
        <Tick at={pct(landmark.mrv)} title={`MRV ${landmark.mrv}`} strong />
      </div>
    </div>
  );
}

function Tick({
  at,
  title,
  strong = false,
}: {
  at: string;
  title: string;
  strong?: boolean;
}) {
  return (
    <div
      title={title}
      className={`absolute top-[-3px] h-[calc(100%+6px)] w-px ${strong ? "bg-ink/55" : "bg-ink/30"}`}
      style={{ left: at }}
    />
  );
}
