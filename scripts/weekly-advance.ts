/**
 * Weekly autoregulation — run Sunday night.
 *
 * Reads last week's actual Hevy training, runs the progression engine to advance
 * the program (the source of truth), and pushes next week's routines to Hevy.
 * "Each next week depends on the previous week's results; never more than one
 * week ahead."
 *
 *   npm run weekly:advance            # DRY RUN — shows what would change + push
 *   npm run weekly:advance -- --apply # advance the plan, push next week to Hevy
 *
 * Guards (it runs unattended): HOLDS unless ≥2 training days happened last week;
 * won't double-advance within 6 days; pushes to Hevy BEFORE persisting the plan
 * (so a failed push retries cleanly); transitions ramp→main at the block end.
 */
import { getProfile } from "../lib/profile";
import { getStore } from "../lib/store/fileStore";
import { readBlockState, writeBlockState } from "../lib/store/blockState";
import { seedProgram } from "../lib/domain/seed";
import { buildCalendar } from "../lib/engine/calendar";
import type { Program } from "../lib/engine/types";
import {
  advanceProgramFromHevy,
  exportWeekToHevy,
  hevyClientFromEnv,
  normalizeHistory,
  type ExportResult,
} from "../lib/integrations/hevy";

const C = { dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
const DAY = 86_400_000;

const TRAINING_DAYS = new Set([1, 4, 6]); // Mon, Thu, Sat
function trainingDates(fromISO: string, count: number): string[] {
  const out: string[] = [];
  const cursor = new Date(`${fromISO}T00:00:00Z`);
  for (let i = 0; i < 60 && out.length < count; i++) {
    if (TRAINING_DAYS.has(cursor.getUTCDay())) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
const dow = (iso: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${iso}T00:00:00Z`).getUTCDay()];

function dayLabelsFor(program: Program, fromISO: string): Record<string, string> {
  const dates = trainingDates(fromISO, program.days.length);
  const labels: Record<string, string> = {};
  program.days.forEach((d, i) => { if (dates[i]) labels[d.id] = `${dow(dates[i])} ${dates[i].slice(5)}`; });
  return labels;
}

/** Carry the dialed-in numbers from one program onto another, matched by exercise name. */
function carryForward(target: Program, source: Program): Program {
  const byName = new Map(source.days.flatMap((d) => d.exercises).map((e) => [e.name, e]));
  return {
    ...target,
    days: target.days.map((day) => ({
      ...day,
      exercises: day.exercises.map((ex) => {
        const src = byName.get(ex.name);
        if (!src || src.loadBasis !== ex.loadBasis) return ex;
        return ex.loadBasis === "max" ? { ...ex, e1rm: src.e1rm ?? ex.e1rm } : { ...ex, workWeight: src.workWeight ?? ex.workWeight };
      }),
    })),
  };
}

/** True only if every day with exercises was written (updated or created). */
function pushComplete(program: Program, pushed: ExportResult): boolean {
  const expected = program.days.filter((d) => d.exercises.length > 0).length;
  return pushed.updated.length + pushed.created.length >= expected;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const store = getStore();
  const program = await store.getProgram();
  const calendar = buildCalendar(program.cycle);
  const blockLength = calendar.length;
  const state = await readBlockState();
  const now = new Date();
  const nowISO = now.toISOString();
  const client = hevyClientFromEnv();

  console.log(`\n${C.bold}Weekly advance${C.reset} ${C.dim}— ${program.name} · ${state.block} week ${state.currentWeek}/${blockLength}${C.reset}`);
  console.log(`${C.dim}${apply ? "APPLYING (advance plan + push next week)" : "DRY RUN — add --apply to write"}${C.reset}\n`);

  // Idempotency: never advance twice in the same period (cron + manual re-run).
  if (apply && state.lastAdvancedISO && now.getTime() - Date.parse(state.lastAdvancedISO) < 6 * DAY) {
    console.log(`${C.yellow}Already advanced on ${state.lastAdvancedISO.slice(0, 10)} (< 6 days ago) — skipping to avoid double-advance.${C.reset}`);
    return;
  }

  // 1. Pull last week's actuals — never before the program start.
  const startMs = Date.parse(`${state.startDate}T00:00:00Z`);
  const since = new Date(Math.max(startMs || 0, now.getTime() - 9 * DAY)).toISOString();
  const [templates, workouts] = await Promise.all([client.getAllTemplates(), client.getAllWorkouts({ since })]);
  const history = normalizeHistory(workouts, templates, { windowDays: 9, now: nowISO });

  // Quorum: require ≥2 distinct training days so one stray session can't advance the week.
  const trainingDayCount = new Set(workouts.map((w) => w.start_time.slice(0, 10))).size;
  const result = advanceProgramFromHevy(program, history, state.currentWeek);
  if (!result.trained || trainingDayCount < 2) {
    console.log(`${C.yellow}Only ${trainingDayCount} training day(s) for ${state.block} week ${state.currentWeek} — holding (need ≥2). Nothing advanced or pushed.${C.reset}`);
    return;
  }

  // 2. Report what the progression engine decided.
  console.log(`${C.bold}Progression from week ${state.currentWeek}${C.reset} ${C.dim}(${result.changes.length} lifts trained)${C.reset}`);
  for (const c of result.changes) {
    const moved = c.field !== "hold" && c.from != null && c.to != null;
    const tag = moved ? `${C.green}${c.from}→${c.to}${program.cycle.unit}${C.reset}` : `${C.dim}hold${C.reset}`;
    console.log(`  ${moved ? C.green + "↑" + C.reset : " "} ${c.exerciseName.padEnd(26)} ${tag}  ${C.dim}${c.note}${C.reset}`);
  }
  console.log();

  const nextWeek = state.currentWeek + 1;
  const upcomingStart = new Date(now.getTime() + DAY).toISOString().slice(0, 10);

  // 3a. Block transition / completion.
  if (nextWeek > blockLength) {
    if (state.block !== "ramp") {
      console.log(`${C.green}${C.bold}🎉 ${state.block} block complete${C.reset} — the program is finished. Configure a new block before the next push.`);
      return;
    }
    // Ramp → main: carry the dialed-in numbers onto the main block, push week 1.
    const main = carryForward(seedProgram(), result.nextProgram);
    const dates = trainingDates(upcomingStart, main.days.length);
    const opts = { week: 1, mode: "create" as const, titlePrefix: "Main W1", dayLabels: dayLabelsFor(main, upcomingStart), folderTitle: `${getProfile().appName} · Main Wk1 (from ${dow(dates[0] ?? upcomingStart)} ${(dates[0] ?? upcomingStart).slice(5)})`, dryRun: !apply };
    console.log(`${C.cyan}${C.bold}Ramp complete → starting the Main block.${C.reset} ${C.dim}Carrying your dialed-in maxes forward.${C.reset}`);
    if (!apply) {
      const preview = await exportWeekToHevy(client, main, opts);
      preview.routines.forEach((r) => console.log(`  ▸ ${r.title} ${C.dim}(${r.exercises.length} exercises)${C.reset}`));
      console.log(`\n${C.dim}Preview only — re-run with --apply.${C.reset}`);
      return;
    }
    const pushed = await exportWeekToHevy(client, main, opts);
    if (!pushComplete(main, pushed)) {
      console.error(`${C.red}Main-block push incomplete — NOT switching blocks (retry next run).${C.reset}`);
      return;
    }
    await store.saveProgram(main);
    await writeBlockState({ block: "main", currentWeek: 1, startDate: dates[0] ?? upcomingStart, lastAdvancedISO: nowISO });
    console.log(`${C.green}${C.bold}Switched to the Main block and pushed week 1.${C.reset} (Old ramp routines remain in Hevy — delete them when ready.)`);
    return;
  }

  // 3b. Normal weekly advance.
  const opts = { week: nextWeek, mode: "update" as const, titlePrefix: `W${nextWeek}`, dayLabels: dayLabelsFor(program, upcomingStart), dryRun: !apply };
  if (!apply) {
    const preview = await exportWeekToHevy(client, result.nextProgram, opts);
    console.log(`${C.bold}Would push week ${nextWeek}${C.reset}`);
    preview.routines.forEach((r) => console.log(`  ▸ ${r.title} ${C.dim}(${r.exercises.length} exercises)${C.reset}`));
    console.log(`\n${C.dim}Preview only — re-run with --apply.${C.reset}`);
    return;
  }
  // Push to Hevy FIRST; only persist the advanced plan once the push is complete.
  const pushed = await exportWeekToHevy(client, result.nextProgram, opts);
  if (!pushComplete(result.nextProgram, pushed)) {
    console.error(`${C.red}Push incomplete (${pushed.updated.length + pushed.created.length} routines) — NOT advancing the plan (retry next run).${C.reset} ${pushed.unresolved.join("; ")}`);
    return;
  }
  await store.saveProgram(result.nextProgram);
  await writeBlockState({ ...state, currentWeek: nextWeek, lastAdvancedISO: nowISO });
  console.log(`${C.green}${C.bold}Advanced to week ${nextWeek} and pushed.${C.reset} Routines: ${[...pushed.updated, ...pushed.created].map((r) => r.title).join(", ")}`);
}

main().catch((err) => {
  console.error(`\n${C.red}Weekly advance failed:${C.reset} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
