/**
 * Pull your Hevy history and calibrate the program from it.
 *
 *   HEVY_API_KEY=xxxx npm run hevy:import            # preview (no writes)
 *   HEVY_API_KEY=xxxx npm run hevy:import -- --apply # write starting weights to the store
 *
 * Flags:
 *   --apply              persist the calibrated program to data/store.json
 *   --window=<days>      history window (default 120)
 *   --seed               calibrate the bundled seed (main) program instead of the store's
 *   --ramp               calibrate the 2-week ramp/calibration block (returning-lifter on-ramp)
 *   --min=<conf>         lowest confidence to auto-apply: high|medium|low (default medium)
 *
 * Get an API key at hevy.com → Settings → API (requires Hevy Pro). The Hevy API
 * serves weights in kg; the app converts them into the program's unit (lb by default).
 */
import { getStore } from "../lib/store/fileStore";
import { rampProgram, seedProgram } from "../lib/domain/seed";
import {
  applyCalibration,
  hevyClientFromEnv,
  importFromHevy,
  type Confidence,
} from "../lib/integrations/hevy";

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
}

const C_DIM = "\x1b[2m", C_BOLD = "\x1b[1m", C_RESET = "\x1b[0m";
const C_GREEN = "\x1b[32m", C_YELLOW = "\x1b[33m", C_RED = "\x1b[31m", C_CYAN = "\x1b[36m";
const confColor: Record<Confidence, string> = { high: C_GREEN, medium: C_CYAN, low: C_YELLOW, none: C_DIM };

async function main() {
  const apply = flag("apply") !== undefined;
  const useSeed = flag("seed") !== undefined;
  const useRamp = flag("ramp") !== undefined;
  const windowDays = Number(flag("window") ?? 120);
  const minConfidence = (flag("min") ?? "medium") as Confidence;

  const client = hevyClientFromEnv();
  const store = getStore();
  const program = useRamp ? rampProgram() : useSeed ? seedProgram() : await store.getProgram();

  console.log(`\n${C_BOLD}Hevy → ${program.name}${C_RESET} ${C_DIM}(window ${windowDays}d, unit ${program.cycle.unit})${C_RESET}`);
  process.stdout.write(`${C_DIM}fetching workouts…${C_RESET}`);

  const { report } = await importFromHevy(client, program, {
    windowDays,
    onProgress: ({ page, pageCount, fetched }) => {
      process.stdout.write(`\r${C_DIM}fetching workouts… page ${page}/${pageCount} (${fetched} in window)${C_RESET}   `);
    },
  });
  process.stdout.write("\r" + " ".repeat(60) + "\r");

  if (report.user?.name) console.log(`Athlete: ${C_BOLD}${report.user.name}${C_RESET}`);
  console.log(
    `Considered ${C_BOLD}${report.workoutsConsidered}${C_RESET} workouts` +
      (report.dateRange ? ` ${C_DIM}(${report.dateRange.from.slice(0, 10)} → ${report.dateRange.to.slice(0, 10)})${C_RESET}` : "") +
      "\n",
  );

  // Per-exercise calibration table.
  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string, n: number) => s.padStart(n);
  console.log(`${C_DIM}${pad("Exercise", 26)}${pad("Hevy match", 28)}${padL("now", 7)}${padL("→ sug", 8)}  conf${C_RESET}`);
  for (const e of report.exercises) {
    const cur = e.current == null ? "—" : `${e.current}${e.unit}`;
    const conf = `${confColor[e.confidence]}${e.confidence}${C_RESET}`;
    const match = e.matchedTitle ? `${e.matchedTitle} ${C_DIM}(${e.matchScore})${C_RESET}` : `${C_DIM}no match${C_RESET}`;
    console.log(`${pad(e.exerciseName, 26)}${pad(match, 28 + (C_DIM.length + C_RESET.length))}${padL(cur, 7)}${padL(e.suggested == null ? "—" : `→ ${e.suggested}${e.unit}`, 8)}  ${conf}`);
  }

  // Rationale for the lifts that actually got a suggestion.
  console.log(`\n${C_BOLD}Why${C_RESET}`);
  for (const e of report.exercises.filter((x) => x.suggested != null && x.confidence !== "none")) {
    console.log(`  ${C_BOLD}${e.exerciseName}${C_RESET}: ${e.rationale}`);
    for (const n of e.notes) console.log(`    ${C_DIM}· ${n}${C_RESET}`);
  }

  // Plan-level recommendations.
  if (report.recommendations.length) {
    console.log(`\n${C_BOLD}Recommendations${C_RESET}`);
    for (const r of report.recommendations) {
      const tag = r.severity === "warn" ? C_RED : r.severity === "suggest" ? C_YELLOW : C_CYAN;
      console.log(`  ${tag}●${C_RESET} ${C_BOLD}${r.title}${C_RESET}\n    ${r.detail}`);
    }
  }

  // Preview or apply.
  const { program: next, changes, skipped } = applyCalibration(program, report, { minConfidence });
  console.log(
    `\n${C_BOLD}${changes.length}${C_RESET} starting weight${changes.length === 1 ? "" : "s"} to apply ` +
      `${C_DIM}(min confidence: ${minConfidence}; ${skipped.length} skipped)${C_RESET}`,
  );
  for (const c of changes) {
    console.log(`  ${C_GREEN}✓${C_RESET} ${pad(c.exerciseName, 24)} ${c.field} ${c.from ?? "—"} → ${C_BOLD}${c.to}${C_RESET} ${C_DIM}[${c.confidence}]${C_RESET}`);
  }

  if (apply) {
    await store.saveProgram(next);
    console.log(`\n${C_GREEN}${C_BOLD}Applied.${C_RESET} Saved to data/store.json. Open Configuration / Program to see the new loads.`);
  } else {
    console.log(`\n${C_DIM}Preview only — re-run with ${C_RESET}${C_BOLD}--apply${C_RESET}${C_DIM} to write these to the store.${C_RESET}`);
  }
}

main().catch((err) => {
  console.error(`\n${C_RED}Hevy import failed:${C_RESET} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
