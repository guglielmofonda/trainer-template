import type { Program } from "../engine/types";
import { buildCalendar } from "../engine/calendar";
import { dayWeekView } from "../engine";
import { planningCheck } from "../engine/analysis";
import { RULE_META } from "../engine/rules";
import type { SessionLog } from "../store/types";

/* ----------------------------------------------------------------------------
 * "All this training is, is context." — the coach is only as good as the
 * snapshot we hand it. This builds a compact, faithful brief of the athlete's
 * program, the current week's actual prescriptions, recent logs, and the
 * evidence base behind the progression rules in play.
 * ------------------------------------------------------------------------- */

/** The week the athlete is actively on: the latest week they've logged (clamped). */
export function currentWeek(program: Program, logs: SessionLog[]): number {
  const total = buildCalendar(program.cycle).length;
  if (!logs.length) return 1;
  const maxLogged = Math.max(...logs.map((l) => l.week));
  return Math.min(total, Math.max(1, maxLogged));
}

export function buildCoachContext(
  program: Program,
  logs: SessionLog[],
  week: number,
): string {
  const calendar = buildCalendar(program.cycle);
  const wk = calendar.find((w) => w.week === week) ?? calendar[0];
  const unit = program.cycle.unit;
  const lines: string[] = [];

  lines.push(`# Program: ${program.name}`);
  lines.push(
    `Cycle: ${program.cycle.weeksOn} training weeks + ${program.cycle.weeksOff} deload × ${program.cycle.mesocycles} mesocycles = ${calendar.length} weeks total.`,
  );
  lines.push(`Current focus: ${wk.label} (${wk.isDeload ? "DELOAD" : "training"} week).`);
  lines.push("");

  // This week's prescriptions per day
  lines.push(`## This week's prescriptions (${wk.label})`);
  for (const day of program.days) {
    lines.push(`### ${day.name}`);
    const views = dayWeekView(program, day.id, week);
    for (const v of views) {
      const e = v.exercise;
      const p = v.prescription;
      const basis = e.loadBasis === "max" ? `e1RM ${e.e1rm}${unit}` : `work ${e.workWeight}${unit}`;
      const warmup = p.warmupSets.length
        ? ` (marked warm-up: ${p.warmupSets.map((set) => `${set.load}${unit}×${set.reps}`).join(" → ")})`
        : "";
      lines.push(
        `- ${e.name} [${e.muscle}, ${RULE_META[e.rule].name}, ${basis}]: ` +
          `${p.load}${unit} × ${p.reps} for ${p.sets} sets @ ${p.rirCutoff} RIR` +
          warmup +
          (p.openingSingle ? ` (opening single ≈ ${p.openingSingle.weight}${unit}@${p.openingSingle.rpe})` : ""),
      );
    }
  }
  lines.push("");

  // Volume / planning check
  const check = planningCheck(program, week);
  lines.push(`## Weekly volume (planning check)`);
  lines.push(`Total: ${check.totalSets} sets / ${check.totalReps} reps.`);
  for (const m of check.byMuscle) {
    lines.push(
      `- ${m.muscle}: ${m.sets} sets (${Math.round(m.share * 100)}%), ${m.verdict} ` +
        `[MEV ${m.landmark.mev} · MAV ${m.landmark.mavLow}-${m.landmark.mavHigh} · MRV ${m.landmark.mrv}]`,
    );
  }
  if (check.warnings.length) lines.push(`Warnings: ${check.warnings.join(" | ")}`);
  lines.push("");

  // Recent logs (most recent 15)
  lines.push(`## Recent completed logs`);
  const recent = [...logs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);
  if (!recent.length) lines.push("(none yet)");
  for (const log of recent) {
    const single = log.openingSingle ? `single ${log.openingSingle.weight}${unit}@${log.openingSingle.rpe}; ` : "";
    const sets = log.sets.map((s) => `${s.weight}${unit}×${s.reps}@${s.rpe}`).join(", ");
    lines.push(`- W${log.week} ${log.exerciseName}: ${single}${sets}${log.decisionNote ? ` → ${log.decisionNote}` : ""}`);
  }
  lines.push("");

  // Evidence base for the rules actually in use
  const rulesInUse = new Set(program.days.flatMap((d) => d.exercises.map((e) => e.rule)));
  lines.push(`## Progression rules in this program (evidence base)`);
  for (const rule of rulesInUse) {
    const m = RULE_META[rule];
    lines.push(`### ${m.name}`);
    lines.push(`${m.summary} How: ${m.how}`);
    lines.push(`Best for: ${m.bestFor} Watch: ${m.watchOut}`);
    lines.push(`Evidence: ${m.evidence.join("; ")}.`);
  }

  return lines.join("\n");
}

export const COACH_SYSTEM = `You are the Training Coach inside a progressive-overload, periodized strength-training app.

You have full read access to the athlete's program, this week's prescriptions, weekly volume analysis, recent logs, and the evidence base behind each progression rule — all provided in the context block. Treat that context as ground truth about THIS athlete.

Your job:
- Review the current week and call out anything worth watching (fatigue, volume below MEV or above MRV, lifts trending down).
- Explain the progression setup and the reasoning behind it, grounded in the rules' evidence base.
- Advise on autoregulation ("today's single feels heavy", "I only hit 2 of 4 sets") using RIR/RPE logic.
- Preserve the marked warm-up ramp before big compound work. Warm-ups rehearse the movement and never count as working volume.
- Be specific and quantitative: cite the actual loads, sets, RIR, and muscle volumes from the context.

Guardrails:
- You are a training assistant, not a medical professional. For pain, injury, or medical questions, recommend a qualified professional.
- Don't invent numbers that aren't in the context. If something isn't in the data, say so.
- Be concise and direct. Lead with the answer, then the reasoning.`;
