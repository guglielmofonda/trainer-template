/**
 * Push one week of the (store) program to Hevy as routines.
 *
 *   npm run hevy:export                         # DRY RUN — shows what would be created
 *   npm run hevy:export -- --push               # actually create the folder + routines
 *
 * Flags:
 *   --push                 perform the writes (default is a dry run)
 *   --week=<n>             which program week to materialize (default 1)
 *   --start=YYYY-MM-DD     first training date; days map to the next Mon/Thu/Sat (default: next such date)
 *   --folder="..."        routine-folder title
 *   --prefix="..."        routine title prefix (e.g. "W1")
 *   --no-custom           do NOT create custom exercises for unmatched lifts (skip them instead)
 *
 * Reads HEVY_API_KEY from .env.local. Creating routines writes to your Hevy account.
 */
import { getStore } from "../lib/store/fileStore";
import { exportWeekToHevy, hevyClientFromEnv } from "../lib/integrations/hevy";

const C = {
  dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
}

/** Training weekdays (JS getUTCDay): Mon=1, Thu=4, Sat=6. */
const TRAINING_DAYS = new Set([1, 4, 6]);

/** The first `count` training dates on/after `startISO` (YYYY-MM-DD), as ISO dates. */
function trainingDates(startISO: string, count: number): string[] {
  const out: string[] = [];
  const cursor = new Date(`${startISO}T00:00:00Z`);
  for (let i = 0; i < 60 && out.length < count; i++) {
    if (TRAINING_DAYS.has(cursor.getUTCDay())) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function dow(iso: string): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

async function main() {
  const push = flag("push") !== undefined;
  const update = flag("update") !== undefined; // PUT onto existing routines instead of creating
  const week = Number(flag("week") ?? 1);
  const noCustom = flag("no-custom") !== undefined;
  const store = getStore();
  const program = await store.getProgram();

  // Map each training day to a date (default: next Mon/Thu/Sat from today).
  const start = flag("start") ?? new Date().toISOString().slice(0, 10);
  const dates = trainingDates(start, program.days.length);
  const dayLabels: Record<string, string> = {};
  program.days.forEach((d, i) => {
    if (dates[i]) dayLabels[d.id] = `${dow(dates[i])} ${dates[i].slice(5)}`;
  });

  const folderTitle = flag("folder") ?? `${shortName(program.name)} · wk ${week}${dates[0] ? ` (from ${dow(dates[0])} ${dates[0].slice(5)})` : ""}`;
  const prefix = flag("prefix") ?? `W${week}`;

  console.log(`\n${C.bold}Hevy export${C.reset} ${C.dim}— ${program.name}, week ${week}${C.reset}`);
  console.log(`${C.dim}Schedule: ${program.days.map((d, i) => `${dayLabels[d.id] ?? "?"}=D${i + 1}`).join("  ")}${C.reset}`);
  console.log(`${C.dim}${push ? "PUSHING to Hevy…" : "DRY RUN (no writes) — add --push to create"}${C.reset}\n`);

  const client = hevyClientFromEnv();
  const result = await exportWeekToHevy(client, program, {
    week,
    folderTitle,
    titlePrefix: prefix,
    dayLabels,
    dryRun: !push,
    createCustom: !noCustom,
    mode: update ? "update" : "create",
  });

  // Template resolution summary.
  const matched = result.resolved.filter((r) => r.source === "matched");
  const custom = result.resolved.filter((r) => r.source === "custom");
  console.log(`${C.bold}Exercise → Hevy template${C.reset} ${C.dim}(${matched.length} matched, ${custom.length} custom, ${result.unresolved.length} unresolved)${C.reset}`);
  for (const r of result.resolved) {
    const tag = r.source === "matched" ? `${C.green}✓${C.reset}` : r.source === "custom" ? `${C.yellow}＋custom${C.reset}` : `${C.red}✗${C.reset}`;
    const to = r.templateTitle ? `${r.templateTitle} ${C.dim}(${r.score})${C.reset}` : r.source === "custom" ? `${C.dim}(will create custom)${C.reset}` : `${C.red}no match${C.reset}`;
    console.log(`  ${tag} ${r.exerciseName.padEnd(24)} → ${to}`);
  }

  // Routine previews.
  for (const routine of result.routines) {
    console.log(`\n${C.bold}▸ ${routine.title}${C.reset} ${C.dim}(${routine.exercises.length} exercises)${C.reset}`);
    for (const ex of routine.exercises) console.log(`    ${ex._label}  ${C.dim}@ ${ex.rest_seconds}s rest${C.reset}`);
  }

  const dropsetLifts = result.routines.flatMap((r) => r.exercises).filter((e) => e._label.includes("(dropset)")).map((e) => e._label.split(" — ")[0]);
  if (dropsetLifts.length) {
    console.log(`\n${C.cyan}Arms dropset finishers (full-body guarantee): ${[...new Set(dropsetLifts)].join(", ")}${C.reset}`);
  }
  if (push) {
    const wrote = [...result.created.map((c) => ({ ...c, verb: "created" })), ...result.updated.map((c) => ({ ...c, verb: "updated" }))];
    console.log(`\n${C.green}${C.bold}${update ? "Updated" : "Pushed"}.${C.reset} ${wrote.length} routines${result.folderId != null ? ` in folder "${result.folderTitle}" (id ${result.folderId})` : ""}:`);
    for (const c of wrote) console.log(`  ${C.green}✓${C.reset} ${c.verb} ${c.title}${c.id ? ` ${C.dim}(${c.id})${C.reset}` : ""}`);
    if (result.customsCreated.length) console.log(`  ${C.dim}Created ${result.customsCreated.length} custom exercises: ${result.customsCreated.map((c) => c.name).join(", ")}${C.reset}`);
  } else {
    console.log(`\n${C.dim}Preview only — re-run with ${C.reset}${C.bold}--push${C.reset}${C.dim}${update ? " (updates existing routines)" : ""} to write to Hevy.${C.reset}`);
  }
  if (result.unresolved.length && noCustom) {
    console.log(`${C.yellow}Unresolved (skipped): ${result.unresolved.join(", ")}${C.reset}`);
  }
}

function shortName(name: string): string {
  return name.split("—")[0].split("·")[0].trim() || name;
}

main().catch((err) => {
  console.error(`\n${C.red}Hevy export failed:${C.reset} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
