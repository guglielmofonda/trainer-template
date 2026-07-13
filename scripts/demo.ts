/**
 * Engine demo — prints the periodization table, a session prescription, the
 * autoregulation response, and the planning check. Run: `npm run engine:demo`.
 * This is a fast, dependency-free way to see the "core bit" working end-to-end.
 */
import { buildCalendar } from "../lib/engine/calendar";
import { periodizationTable } from "../lib/engine/periodization";
import { prescribe } from "../lib/engine/prescription";
import { progress } from "../lib/engine/rules";
import { planningCheck } from "../lib/engine/analysis";
import { SEED_PROGRAM } from "../lib/domain/seed";

const squat = SEED_PROGRAM.days[0].exercises[0];
const cal = buildCalendar(SEED_PROGRAM.cycle);

console.log(`\n=== ${SEED_PROGRAM.name} ===`);
console.log(`Cycle: ${SEED_PROGRAM.cycle.weeksOn} on / ${SEED_PROGRAM.cycle.weeksOff} off · ${SEED_PROGRAM.cycle.mesocycles} mesos = ${cal.length} weeks\n`);

console.log(`--- ${squat.name} periodization (e1RM ${squat.e1rm}) ---`);
console.log("wk  label          reps sets rir  intensity");
for (const r of periodizationTable(squat.wave, cal)) {
  if (r.isDeload) {
    console.log(`${String(r.week).padStart(2)}  ${r.label.padEnd(14)} deload  ${r.sets} sets`);
  } else {
    console.log(
      `${String(r.week).padStart(2)}  ${r.label.padEnd(14)} ${String(r.reps).padStart(3)} ${String(r.sets).padStart(4)} ${String(r.rir).padStart(4)}  ${r.intensity.toFixed(2)}x`,
    );
  }
}

console.log(`\n--- Session: ${squat.name}, week 4 ---`);
const plans = periodizationTable(squat.wave, cal);
const wk4 = plans.find((p) => p.week === 4)!;
for (const single of [375, 410, 455]) {
  const rx = prescribe(squat, wk4, { openingSingle: { weight: single, rpe: 8 } });
  console.log(
    `opening single ${single}@8 → e1RM ${rx.basisE1rm} → work sets ${rx.load} × ${rx.reps}, ${rx.sets} sets, stop @ ${rx.rirCutoff} RIR`,
  );
}

console.log(`\n--- Autoregulation: hit the set cap (4 quality sets) ---`);
const decision = progress(squat, wk4, {
  exerciseId: squat.id,
  week: 4,
  setsCompleted: 4,
  sets: Array(4).fill({ weight: 320, reps: 5, rpe: 7.5 }),
});
console.log(decision.note);

console.log(`\n--- Planning check (week 1) ---`);
const check = planningCheck(SEED_PROGRAM, 1);
console.log(`Total: ${check.totalSets} sets / ${check.totalReps} reps`);
for (const m of check.byMuscle) {
  console.log(
    `${m.muscle.padEnd(12)} ${String(m.sets).padStart(2)} sets  ${(m.share * 100).toFixed(0).padStart(3)}%  [${m.verdict}]`,
  );
}
if (check.warnings.length) console.log("\nWarnings:\n- " + check.warnings.join("\n- "));
console.log();
