/**
 * Match a program's exercises to the Hevy exercises the athlete actually trained.
 *
 * PURE. This is the riskiest step (a wrong match seeds a wrong weight), so the
 * design favors precision and *transparency*: every match carries a 0..1 score
 * and the runner-up alternates, and nothing is matched silently — the caller
 * (and ultimately the UI) shows which Hevy lift fed each suggestion so the
 * athlete can veto it. Trust is the product's thesis.
 *
 * Strategy:
 *  1. Parse titles into a core-token set + an equipment/modifier set
 *     (so "Incline Bench Press (Dumbbell)" → core {incline,bench,press},
 *     equip {dumbbell}).
 *  2. Weight token overlap by IDF over the set of templates the athlete actually
 *     used — so distinctive tokens ("pulldown", "romanian") dominate generic
 *     ones ("leg", "press"). A match must cover the distinctive tokens, not just
 *     a shared generic one (this is what stops "Leg Extension" ↔ "Leg Press").
 *  3. An ALIAS table pins the 24 seed lifts to precise keyword/equipment/exclude
 *     rules; unknown (user-added) exercises fall back to parsing their own name.
 */
import type { MuscleGroup, Program } from "../../engine/types";
import type { ExerciseHistory, NormalizedHistory } from "./normalize";

export interface MatchCandidate {
  templateId: string;
  title: string;
  score: number;
}

export interface ExerciseMatch {
  exerciseId: string;
  exerciseName: string;
  templateId: string | null;
  templateTitle: string | null;
  score: number;
  /**
   * True when the program slot specifies an equipment (e.g. barbell) but the only
   * match found is explicitly different equipment (e.g. dumbbell). Hevy logs
   * barbell as total-bar load and dumbbell as per-hand load (~2× apart), so the
   * calibrator caps such a match's confidence and never auto-applies it.
   */
  equipmentMismatch: boolean;
  /** The matched template's mapped muscle differs from the program slot's muscle. */
  muscleMismatch: boolean;
  /** Next-best candidates (for "did we pick the right one?" transparency). */
  alternates: MatchCandidate[];
}

interface ParsedTitle {
  core: string[];
  equipment: Set<string>;
}

interface AliasRule {
  /** Core tokens that should appear in the template title (scored by IDF). */
  keywords: string[];
  /** Movement-defining tokens that MUST all be present (hard gate, score 0 if any missing).
   *  e.g. a "leg curl" rule requires "curl" so "Leg Press" can never satisfy it. */
  require?: string[];
  /** Soft disambiguators (e.g. a stance word): a small bonus when present, never required,
   *  so an unqualified "Calf Raise" still matches but a qualified one routes correctly. */
  prefer?: string[];
  /** Preferred equipment token (boosts a match, penalizes a clear mismatch). */
  equipment?: string;
  /** Hard veto: if the template contains any of these tokens, it cannot match. */
  exclude?: string[];
}

/** Equipment / modifier tokens — stripped from the "core" and matched separately. */
const EQUIPMENT = new Set([
  "barbell", "dumbbell", "machine", "cable", "smith", "kettlebell", "band", "bands",
  "ezbar", "ez", "sled", "lever", "assisted", "weighted", "bodyweight", "plate", "resistance",
]);

/** Token rewrites: abbreviations → canonical, common plurals → singular. */
const REWRITE: Record<string, string> = {
  db: "dumbbell", dbs: "dumbbell", bb: "barbell",
  tricep: "triceps", bicep: "biceps",
  raises: "raise", curls: "curl", rows: "row", presses: "press",
  extensions: "extension", pushdowns: "pushdown", flyes: "fly", flys: "fly",
  pulldowns: "pulldown", thrusts: "thrust", lunges: "lunge", squats: "squat",
  deadlifts: "deadlift", pullups: "pullup",
};

/** Multi-token expansions applied before tokenization scoring. */
const EXPAND: Record<string, string[]> = {
  ohp: ["overhead", "press"],
  rdl: ["romanian", "deadlift"],
};

const STOPWORDS = new Set(["the", "a", "an", "with", "and", "of", "for", "on", "in", "your"]);

/**
 * Precise rules for the seed program's lifts, keyed by the normalized exercise
 * name. Generic exercises (custom programs) fall back to parsing their own name.
 */
const ALIAS: Record<string, AliasRule> = {
  "back squat": { keywords: ["squat"], equipment: "barbell", exclude: ["front", "split", "hack", "goblet", "bulgarian", "zercher", "box", "overhead"] },
  "front squat": { keywords: ["front", "squat"], equipment: "barbell" },
  "bulgarian split squat": { keywords: ["bulgarian", "squat"] },
  "bench press": { keywords: ["bench", "press"], equipment: "barbell", exclude: ["incline", "decline", "close"] },
  "incline bench press": { keywords: ["incline", "press"], equipment: "barbell", exclude: ["decline"] },
  "incline db press": { keywords: ["incline", "press"], equipment: "dumbbell", exclude: ["decline"] },
  "deadlift": { keywords: ["deadlift"], equipment: "barbell", exclude: ["romanian", "stiff", "deficit", "single", "dumbbell"] },
  "romanian deadlift": { keywords: ["romanian", "deadlift"] },
  "overhead press": { keywords: ["overhead", "press"], equipment: "barbell", exclude: ["triceps", "extension"] },
  "weighted pull-up": { keywords: ["pull", "up"], exclude: ["push", "lat", "pushup"] },
  "lat pulldown": { keywords: ["lat", "pulldown"], equipment: "cable", exclude: ["straight"] },
  "chest supported row": { keywords: ["chest", "row"], exclude: ["upright", "press"] },
  "leg extension": { keywords: ["leg", "extension"], require: ["extension"] },
  "leg press": { keywords: ["leg", "press"], require: ["press"], exclude: ["extension", "curl", "calf", "chest", "shoulder"] },
  // require "curl" so a "Leg Press" (quads) can't satisfy it on {leg, seated} alone;
  // "seated" is only a preference so "Lying Leg Curl" remains an acceptable fallback.
  "seated leg curl": { keywords: ["leg", "curl"], require: ["curl"], prefer: ["seated"], exclude: ["nordic"] },
  "lateral raise": { keywords: ["lateral", "raise"], equipment: "dumbbell", exclude: ["front", "rear"] },
  "rear delt fly": { keywords: ["rear", "fly"] },
  "triceps pushdown": { keywords: ["triceps", "pushdown"] },
  "overhead triceps extension": { keywords: ["triceps", "extension"], exclude: ["pushdown", "leg"] },
  "barbell curl": { keywords: ["curl"], equipment: "barbell", exclude: ["hammer", "preacher", "spider", "incline", "concentration", "leg", "reverse", "wrist"] },
  "hammer curl": { keywords: ["hammer", "curl"], require: ["hammer"], equipment: "dumbbell" },
  // Keep "calf" the scored token and the stance only a preference, so an unqualified
  // "Calf Raise (Machine)" still clears threshold while explicit stances route correctly.
  "standing calf raise": { keywords: ["calf", "raise"], prefer: ["standing"], exclude: ["seated", "donkey"] },
  "seated calf raise": { keywords: ["calf", "raise"], prefer: ["seated"], exclude: ["standing", "donkey"] },
  "hip thrust": { keywords: ["hip", "thrust"] },
  "hanging leg raise": { keywords: ["hanging", "raise"], exclude: ["lying", "captain"] },
  "cable crunch": { keywords: ["crunch"], equipment: "cable", exclude: ["decline", "machine"] },
  "decline crunch": { keywords: ["decline", "crunch"], exclude: ["cable", "machine"] },
};

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function parseTitle(raw: string): ParsedTitle {
  const equipment = new Set<string>();
  const core: string[] = [];
  const rawTokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const t0 of rawTokens) {
    const expanded = EXPAND[t0] ?? [t0];
    for (const e of expanded) {
      const t = REWRITE[e] ?? e;
      if (EQUIPMENT.has(t)) {
        equipment.add(t);
        continue;
      }
      if (STOPWORDS.has(t)) continue;
      core.push(t);
    }
  }
  return { core, equipment };
}

/** The keyword/equipment rule for a program exercise (alias or parsed fallback). */
function ruleFor(name: string): AliasRule {
  const key = normalizeName(name);
  if (ALIAS[key]) return ALIAS[key];
  const parsed = parseTitle(name);
  return {
    keywords: parsed.core,
    equipment: parsed.equipment.values().next().value,
  };
}

interface Idf {
  weight(token: string): number;
}

function buildIdf(histories: ExerciseHistory[]): Idf {
  const df = new Map<string, number>();
  const n = histories.length || 1;
  for (const h of histories) {
    const seen = new Set(parseTitle(h.title).core);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const maxIdf = Math.log(1 + n);
  return {
    weight(token: string) {
      const d = df.get(token);
      // A token in no template is maximally distinctive (and unmatchable anyway).
      return d ? Math.log(1 + n / d) : maxIdf;
    },
  };
}

/** Optional muscle context for a soft (never-vetoing) agreement adjustment. */
export interface ScoreContext {
  /** The program slot's muscle. */
  programMuscle?: MuscleGroup;
  /** The candidate template's mapped muscle (null when Hevy's slug doesn't map). */
  candidateMuscle?: MuscleGroup | null;
}

/** Score a program rule against one candidate template title, 0..1. */
export function scoreMatch(rule: AliasRule, title: string, idf: Idf, ctx: ScoreContext = {}): number {
  const parsed = parseTitle(title);
  const titleTokens = new Set(parsed.core);

  if (rule.exclude?.some((x) => titleTokens.has(x))) return 0;
  // Movement-defining tokens are a hard gate: all must be present.
  if (rule.require?.some((r) => !titleTokens.has(r))) return 0;
  if (rule.keywords.length === 0) return 0;

  let matched = 0;
  let total = 0;
  for (const k of rule.keywords) {
    const w = idf.weight(k);
    total += w;
    if (titleTokens.has(k)) matched += w;
  }
  let score = total > 0 ? matched / total : 0;

  // Soft disambiguators (stance, etc.): a small bonus when present.
  if (rule.prefer?.some((p) => titleTokens.has(p))) score = Math.min(1, score + 0.06);

  // Equipment is a tie-breaker, not a gate: reward a hit, lightly penalize a
  // clear mismatch (e.g. wanting dumbbell, finding an explicitly-barbell lift).
  if (rule.equipment) {
    if (parsed.equipment.has(rule.equipment)) score = Math.min(1, score + 0.08);
    else if (parsed.equipment.size > 0) score *= 0.82;
  }

  // Specificity penalty, applied LAST so the equipment-bonus cap can't mask it:
  // penalize candidate tokens that aren't part of the rule, so the canonical name
  // wins over an elaborate variant ("Squat (Barbell)" > "Pause Squat (Barbell)",
  // "Deadlift" > "Deadlift High Pull"). Equipment tokens are already out of `core`.
  const known = new Set([...rule.keywords, ...(rule.prefer ?? [])]);
  const extra = parsed.core.filter((t) => !known.has(t)).length;
  if (extra > 0) score *= Math.max(0.5, 1 - 0.07 * extra);

  // Muscle agreement: a gentle adjustment only (never a veto) — taxonomies differ
  // across apps (a deadlift may be tagged hamstrings vs lower-back), so this just
  // breaks ties, it can't reject an otherwise-strong match.
  if (ctx.programMuscle && ctx.candidateMuscle) {
    score *= ctx.candidateMuscle === ctx.programMuscle ? 1 : 0.9;
  }
  return score;
}

/** Whether the program slot wants one equipment but the title is explicitly another. */
function equipmentContradicts(rule: AliasRule, title: string): boolean {
  if (!rule.equipment) return false;
  const eq = parseTitle(title).equipment;
  return eq.size > 0 && !eq.has(rule.equipment);
}

export interface MatchOptions {
  /** Minimum score to accept a match. Default 0.6. */
  threshold?: number;
}

export function matchProgramToHistory(
  program: Program,
  history: NormalizedHistory,
  opts: MatchOptions = {},
): ExerciseMatch[] {
  const threshold = opts.threshold ?? 0.6;
  const histories = [...history.byTemplate.values()];
  const idf = buildIdf(histories);
  const out: ExerciseMatch[] = [];
  const seen = new Set<string>(); // a program exercise name appears once per match pass

  for (const day of program.days) {
    for (const ex of day.exercises) {
      if (seen.has(ex.id)) continue;
      seen.add(ex.id);
      const rule = ruleFor(ex.name);
      const scored = histories
        .map((h) => ({
          templateId: h.templateId,
          title: h.title,
          muscle: h.muscle,
          score: scoreMatch(rule, h.title, idf, { programMuscle: ex.muscle, candidateMuscle: h.muscle }),
        }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      const accepted = best && best.score >= threshold ? best : null;
      out.push({
        exerciseId: ex.id,
        exerciseName: ex.name,
        templateId: accepted?.templateId ?? null,
        templateTitle: accepted?.title ?? null,
        score: best?.score ?? 0,
        equipmentMismatch: accepted ? equipmentContradicts(rule, accepted.title) : false,
        muscleMismatch: accepted ? Boolean(accepted.muscle && accepted.muscle !== ex.muscle) : false,
        alternates: scored.slice(accepted ? 1 : 0, accepted ? 3 : 2).map(({ templateId, title, score }) => ({ templateId, title, score })),
      });
    }
  }
  return out;
}

/**
 * Resolve a single exercise name to its best template in `history` (which may be a
 * synthetic history built from the full catalog). Used by the routine exporter to
 * resolve ad-hoc lifts like the arms-finisher, reusing the same alias/IDF scoring.
 */
export function bestTemplateMatch(
  name: string,
  muscle: MuscleGroup | undefined,
  history: NormalizedHistory,
  opts: MatchOptions = {},
): MatchCandidate | null {
  const threshold = opts.threshold ?? 0.6;
  const histories = [...history.byTemplate.values()];
  const idf = buildIdf(histories);
  const rule = ruleFor(name);
  const scored = histories
    .map((h) => ({ templateId: h.templateId, title: h.title, score: scoreMatch(rule, h.title, idf, { programMuscle: muscle, candidateMuscle: h.muscle }) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best && best.score >= threshold ? best : null;
}
