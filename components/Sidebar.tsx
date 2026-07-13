"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Gauge,
  Table2,
  Dumbbell,
  ClipboardList,
  MessagesSquare,
  BookOpen,
  LogOut,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { BrandMark, Badge } from "@/components/ui";

interface NavItem {
  href: string;
  label: string;
  short: string;
  icon: LucideIcon;
  group: "Plan" | "Train" | "Reference";
}

const NAV: NavItem[] = [
  { href: "/configuration", label: "Configuration", short: "Plan", icon: Gauge, group: "Plan" },
  { href: "/program", label: "Program", short: "Block", icon: Table2, group: "Plan" },
  { href: "/session", label: "Today's session", short: "Train", icon: Dumbbell, group: "Train" },
  { href: "/review", label: "Workout review", short: "Review", icon: ClipboardList, group: "Train" },
  { href: "/progress", label: "Progress", short: "Trend", icon: TrendingUp, group: "Train" },
  { href: "/coach", label: "Training coach", short: "Coach", icon: MessagesSquare, group: "Train" },
  { href: "/theory", label: "Theory", short: "Theory", icon: BookOpen, group: "Reference" },
];

const GROUPS = ["Plan", "Train", "Reference"] as const;

function useActive() {
  const path = usePathname();
  return (href: string) => path === href || (href !== "/" && path.startsWith(href));
}

function Brand({ appName, monogram, tagline }: { appName: string; monogram: string; tagline: string }) {
  return (
    <Link
      href="/configuration"
      className="flex items-center gap-2.5 rounded-md outline-none"
      aria-label={`${appName} — home`}
    >
      <span className="grid size-8 place-items-center rounded-[2px] border border-border bg-bg text-ink-strong">
        <BrandMark className="size-5" monogram={monogram} />
      </span>
      <span className="leading-tight">
        <span className="display block text-[0.95rem] font-medium text-ink-strong">
          {appName}
        </span>
        <span className="block text-[0.6875rem] text-faint">{tagline}</span>
      </span>
    </Link>
  );
}

function CoachStatus({ coachOnline }: { coachOnline: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="hidden text-[0.6875rem] text-faint sm:inline">Coach</span>
      {coachOnline ? (
        <Badge tone="success" dot>
          Opus 4.8
        </Badge>
      ) : (
        <Badge tone="default" dot>
          offline mode
        </Badge>
      )}
    </div>
  );
}

export function Sidebar({
  coachOnline = false,
  appName = "Trainer",
  monogram = "Tr",
  tagline = "progressive overload",
}: {
  coachOnline?: boolean;
  appName?: string;
  monogram?: string;
  tagline?: string;
}) {
  const brand = <Brand appName={appName} monogram={monogram} tagline={tagline} />;
  const isActive = useActive();

  return (
    <>
      {/* Desktop: fixed left rail */}
      <aside className="hidden shrink-0 flex-col border-r border-border-soft bg-surface md:flex md:w-[232px]">
        <div className="border-b border-border-soft px-4 py-4">
          {brand}
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-2.5 py-4">
          {GROUPS.map((group) => (
            <div key={group}>
              <div className="px-2.5 pb-1.5 text-[0.625rem] font-medium uppercase tracking-[0.12em] text-faint">
                {group}
              </div>
              <div className="space-y-0.5">
                {NAV.filter((n) => n.group === group).map((item) => {
                  const active = isActive(item.href);
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-2.5 rounded-[2px] px-2.5 py-2 text-[0.8125rem] transition-colors duration-[var(--dur-fast)] ease-out ${
                        active
                          ? "bg-surface-2 font-semibold text-ink-strong"
                          : "text-muted hover:bg-surface hover:text-ink"
                      }`}
                    >
                      <Icon
                        className={`size-4 shrink-0 ${active ? "text-ink-strong" : "text-faint"}`}
                        strokeWidth={2}
                      />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="space-y-3 border-t border-border-soft px-4 py-3.5">
          <CoachStatus coachOnline={coachOnline} />
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-[2px] border border-border bg-bg px-3 text-[0.8125rem] text-muted transition-colors duration-[var(--dur-fast)] ease-out hover:border-border-strong hover:bg-surface hover:text-ink"
            >
              <LogOut className="size-3.5" />
              Log out
            </button>
          </form>
          <p className="text-[0.6875rem] leading-relaxed text-faint">
            {appName} is built around a periodized strength engine.
            <br />
            The engine is the core.
          </p>
        </div>
      </aside>

      {/* Mobile: top bar (fixed above the scrolling main) */}
      <header className="shrink-0 border-b border-border-soft bg-surface md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          {brand}
          <div className="flex items-center gap-2">
            <CoachStatus coachOnline={coachOnline} />
            <form action="/api/auth/logout" method="post">
              <button
                type="submit"
                aria-label="Log out"
                className="grid size-8 place-items-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <LogOut className="size-4" />
              </button>
            </form>
          </div>
        </div>
        <nav className="-mt-0.5 grid grid-cols-7 gap-1 px-3 pb-2">
          {NAV.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-[2px] px-1.5 py-1.5 text-[0.6875rem] transition-colors duration-[var(--dur-fast)] ease-out ${
                  active
                    ? "bg-surface-2 font-semibold text-ink-strong"
                    : "text-muted hover:bg-surface"
                }`}
              >
                <Icon
                  className={`size-3.5 ${active ? "text-ink-strong" : "text-faint"}`}
                  strokeWidth={2}
                />
                <span className="max-w-full truncate">{item.short}</span>
              </Link>
            );
          })}
        </nav>
      </header>
    </>
  );
}
