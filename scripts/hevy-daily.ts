/**
 * Daily analysis — runs on the WEBSITE's program (the production Blob when its
 * token is configured, otherwise local data/store.json) using Hevy actuals for the
 * update. Writes a Markdown report to stdout, $GITHUB_STEP_SUMMARY, and
 * reports/hevy-latest.md plus data/hevy-history.json (committed back by the
 * GitHub Action).
 *
 * Data flow: website (program) → GitHub → pull Hevy (actuals) → analyse here.
 *
 *   HEVY_API_KEY=xxxx npm run hevy:daily            # window 14d
 *   HEVY_API_KEY=xxxx npm run hevy:daily -- --days=30
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { getProfile } from "../lib/profile";
import { getStore } from "../lib/store/fileStore";
import { buildCalendar } from "../lib/engine/calendar";
import { planningCheck } from "../lib/engine/analysis";
import { readBlockState } from "../lib/store/blockState";
import {
  actualWeekVolume,
  calibrate,
  hevyClientFromEnv,
  matchProgramToHistory,
  normalizeHistory,
  parseDayIdFromTitle,
  weekForWorkout,
  workoutImpact,
} from "../lib/integrations/hevy";
import {
  resolveActiveWeek,
  type CompletedTrainingSession,
  type TrainingHistorySnapshot,
} from "../lib/trainingProgress";

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}`));
  return hit?.includes("=") ? hit.slice(hit.indexOf("=") + 1) : hit ? "" : undefined;
}

const KG_PER_LB = 0.45359237;

async function main() {
  const days = Number(flag("days") ?? 14);
  const now = new Date();
  const nowISO = now.toISOString();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();

  // 1. The website's source of truth: the program (+ logs) from the store.
  const store = getStore();
  const [program, logs] = await Promise.all([store.getProgram(), store.getLogs()]);
  const unit = program.cycle.unit;
  const wt = (kg: number | null) => (kg == null ? "BW" : unit === "lb" ? `${Math.round(kg / KG_PER_LB)}lb` : `${Math.round(kg * 10) / 10}kg`);

  // 2. Pull the Hevy actuals for the update window.
  const client = hevyClientFromEnv();
  const [templates, workouts, user] = await Promise.all([
    client.getAllTemplates(),
    client.getAllWorkouts({ since }),
    client.getUserInfo().catch(() => undefined),
  ]);
  const titleById = new Map(templates.map((t) => [t.id, t.title]));

  // Keep a durable, machine-readable completion history for the Session and
  // Program screens. Merge rather than replace so dates do not disappear when
  // they age out of the daily look-back window.
  const state = await readBlockState();
  const totalWeeks = buildCalendar(program.cycle).length;
  const historyFile = path.join(process.cwd(), "data", "hevy-history.json");
  let previousHistory: TrainingHistorySnapshot = { pulledAt: null, windowDays: days, sessions: [] };
  try {
    previousHistory = JSON.parse(await fs.readFile(historyFile, "utf8")) as TrainingHistorySnapshot;
  } catch {
    // First run: the current Hevy window seeds the history.
  }
  const pulledSessions: CompletedTrainingSession[] = workouts.flatMap((workout) => {
    const dayId = parseDayIdFromTitle(workout.title, program);
    if (!dayId) return [];
    const week = weekForWorkout(workout, state.startDate, totalWeeks);
    if (week == null) return [];
    return [{
      workoutId: workout.id,
      dayId,
      week,
      date: workout.start_time.slice(0, 10),
      title: workout.title,
      source: "hevy" as const,
    }];
  });
  const sessions = [...new Map(
    [...previousHistory.sessions, ...pulledSessions].map((session) => [session.workoutId, session]),
  ).values()].sort((a, b) => a.date.localeCompare(b.date));
  const historySnapshot: TrainingHistorySnapshot = { pulledAt: nowISO, windowDays: days, sessions };
  await fs.writeFile(
    historyFile,
    JSON.stringify(historySnapshot, null, 2) + "\n",
    "utf8",
  );

  // 3. Analyse: the website's program against its landmarks, and vs the actuals.
  const week = resolveActiveWeek(program, logs, historySnapshot, state.currentWeek);
  const check = planningCheck(program, week);
  const history = normalizeHistory(workouts, templates, { windowDays: days, now: nowISO });
  const matches = matchProgramToHistory(program, history);
  const report = calibrate(program, history, matches, { now: nowISO, windowDays: days });

  const L: string[] = [];
  L.push(`## 🏋️ ${getProfile().appName} — daily analysis · ${nowISO.slice(0, 10)}`);
  L.push(`Program (source of truth): **${program.name}** — week ${week}` + (user?.name ? ` · ${user.name}` : ""));
  L.push(`Hevy actuals pulled: **${report.workoutsConsidered}** workouts in the last ${days} days` + (report.dateRange ? ` (→ ${report.dateRange.to.slice(0, 10)})` : ""));
  L.push("");

  // Plan volume vs landmarks (this week).
  L.push(`### This week's plan vs landmarks`);
  L.push(`Total: ${check.totalSets} working sets / ${check.totalReps} reps.`);
  for (const m of check.byMuscle) L.push(`- ${m.muscle}: ${m.sets} sets — ${m.verdict} (MEV ${m.landmark.mev} · MAV ${m.landmark.mavLow}–${m.landmark.mavHigh} · MRV ${m.landmark.mrv})`);
  if (check.warnings.length) L.push(`> ${check.warnings.join(" · ")}`);
  L.push("");

  // Actual trained volume for the most recent training week: every working set
  // counts — planned lifts, same-muscle swaps, and unplanned extras.
  const impacts = workouts.flatMap((workout) => {
    const workoutWeek = weekForWorkout(workout, state.startDate, totalWeeks);
    return workoutWeek == null ? [] : [workoutImpact(program, workout, templates, workoutWeek)];
  });
  const newest = [...impacts].sort((a, b) => b.startTime.localeCompare(a.startTime))[0];
  if (newest) {
    const volWeek = newest.week;
    const vol = actualWeekVolume(program, impacts, volWeek);
    const weekImpacts = impacts.filter((i) => i.week === volWeek);
    const working = (sets: Array<{ type: string }>) => sets.filter((s) => s.type !== "warmup").length;
    const dayLabel = (iso: string) => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(iso).getUTCDay()]} ${iso.slice(5, 10)}`;

    L.push(`### Trained volume — week ${volWeek} (actual vs planned)`);
    L.push(`Every working set counts: planned lifts, same-muscle swaps, and extras. Warm-ups excluded.`);
    for (const m of vol.byMuscle) {
      const mix = [
        m.fromSwaps ? `${m.fromSwaps} swapped` : "",
        m.fromExtras ? `${m.fromExtras} extra` : "",
      ].filter(Boolean).join(" · ");
      L.push(`- ${m.muscle}: **${m.sets}** done / ${m.plannedSets} planned${mix ? ` (${mix})` : ""} — ${m.verdict}`);
    }
    if (vol.unmappedSets) L.push(`- _+${vol.unmappedSets} working sets on lifts without a mapped muscle group._`);
    const swaps = weekImpacts.flatMap((i) =>
      i.exercises
        .filter((r) => r.status === "swapped")
        .map((r) => `${r.exercise.name} → ${r.templateTitle} (${dayLabel(i.startTime)}, ${working(r.actualSets)} sets)`),
    );
    if (swaps.length) L.push(`- Swaps: ${swaps.join("; ")}`);
    const extras = weekImpacts.flatMap((i) =>
      i.extras
        .filter((e) => working(e.actualSets) > 0)
        .map((e) => `${e.title}${e.muscle ? ` · ${e.muscle}` : ""} (${dayLabel(i.startTime)}, ${working(e.actualSets)} sets)`),
    );
    if (extras.length) L.push(`- Extras: ${extras.join("; ")}`);
    L.push("");
  }

  // Calibration read (actuals vs the plan's current anchors).
  const notable = report.exercises.filter((e) => e.suggested != null && e.changePct != null && Math.abs(e.changePct) >= 10);
  if (notable.length) {
    L.push(`### Calibration read — lifts drifting from your plan`);
    for (const e of notable) L.push(`- **${e.exerciseName}**: plan ${e.current}${e.unit} vs your data ${e.suggested}${e.unit} (${e.changePct! > 0 ? "+" : ""}${e.changePct}%, ${e.confidence})`);
    L.push("");
  }
  const recs = report.recommendations.filter((r) => r.kind !== "no-history");
  if (recs.length) {
    L.push(`### Notes`);
    for (const r of recs) L.push(`- **${r.title}** — ${r.detail}`);
    L.push("");
  }

  // Recent Hevy sessions (the raw actuals).
  L.push(`### Recent sessions`);
  const recent = [...workouts].sort((a, b) => b.start_time.localeCompare(a.start_time)).slice(0, 5);
  if (!recent.length) L.push("_No workouts logged in this window._");
  for (const w of recent) {
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(w.start_time).getUTCDay()];
    L.push(`**${dow} ${w.start_time.slice(0, 10)} · ${w.title}**`);
    for (const ex of w.exercises) {
      const warmups = ex.sets.filter((s) => s.type === "warmup" && typeof s.reps === "number");
      const working = ex.sets.filter((s) => s.type !== "warmup" && typeof s.reps === "number");
      if (!warmups.length && !working.length) continue;
      const parts: string[] = [];
      if (warmups.length) {
        parts.push(`**warm-up** ${warmups.map((s) => `${wt(s.weight_kg)}×${s.reps}`).join(" → ")}`);
      }
      if (working.length) {
        parts.push(`work ${working.map((s) => `${wt(s.weight_kg)}×${s.reps}${s.rpe != null ? `@${s.rpe}` : ""}`).join(", ")}`);
      }
      L.push(`- ${titleById.get(ex.exercise_template_id) ?? ex.title}: ${parts.join(" · ")}`);
    }
  }
  L.push("");
  L.push(`<sub>Analysis on the website's program + Hevy actuals · pulled ${nowISO} · window ${days}d.</sub>`);

  const md = L.join("\n");
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  const reportDir = path.join(process.cwd(), "reports");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "hevy-latest.md"), md + "\n", "utf8");
}

main().catch((err) => {
  console.error(`Daily analysis failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
