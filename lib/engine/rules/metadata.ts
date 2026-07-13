import type { ProgressionRuleId } from "../types";

/**
 * Help-card content for each progression rule. Mirrors the in-app cards from the
 * source (e.g. the "Set-threshold RIR" card citing the SBS bundle & Refalo 2023).
 * Used by the configuration UI, the THEORY doc, and the AI coach as grounding.
 */
export interface RuleMeta {
  id: ProgressionRuleId;
  name: string;
  /** One-line summary of the mechanic. */
  summary: string;
  /** How the next session/week is decided. */
  how: string;
  /** When to reach for it. */
  bestFor: string;
  /** Where it bites if misused. */
  watchOut: string;
  /** Evidence / lineage tags. */
  evidence: string[];
}

export const RULE_META: Record<ProgressionRuleId, RuleMeta> = {
  "set-threshold-rir": {
    id: "set-threshold-rir",
    name: "Set-threshold RIR",
    summary:
      "Repeat the planned reps at a fixed RIR cutoff; the number of quality sets you complete decides the next load change.",
    how: "Do work sets at the prescribed load, stopping each set the moment you hit the RIR cutoff. Complete the planned set count → add load next week and reset reps. Fall short → hold the load and repeat.",
    bestFor:
      "Squat, bench, deadlift and close variants when you want quality volume without grinding a rep-out.",
    watchOut:
      "Use conservative cutoffs for deadlifts, RDLs, tempo and pause squats — fatigue accrues fast and form decays before RIR feels low.",
    evidence: ["SBS program bundle", "Refalo 2023 (proximity-to-failure & hypertrophy)"],
  },
  "last-set-rir": {
    id: "last-set-rir",
    name: "Last-set RIR",
    summary: "Autoregulate load from how much was left in the tank on the final set.",
    how: "Read the RIR of the last work set. Easier than target → bigger jump; on target → standard jump; harder than target → hold or back off.",
    bestFor: "Lifters who are accurate at rating RPE and want straightforward week-to-week tuning.",
    watchOut: "RPE accuracy drifts when tired or under-recovered; one bad rating moves the whole load.",
    evidence: ["Helms et al. 2018 (RPE for resistance training)", "Tuchscherer RTS"],
  },
  "reps-to-failure": {
    id: "reps-to-failure",
    name: "Reps to failure",
    summary: "Last set is an all-out AMRAP; reps beyond target buy load.",
    how: "Take the final set to true failure. Reps over the target add load next time; hitting target holds; missing it backs off.",
    bestFor: "Accessories and machine work where failure is safe and a strong hypertrophy driver.",
    watchOut: "High fatigue cost on compounds; failure every week erodes recovery and joint health.",
    evidence: ["Schoenfeld & Grgic (failure & hypertrophy)", "Refalo 2023"],
  },
  "double-progression": {
    id: "double-progression",
    name: "Double progression",
    summary: "Grow reps inside a bracket to a cap, then add load and reset reps.",
    how: "Hold the load and add reps each session until every set hits the rep cap; then bump the load and drop back to the bottom of the rep range.",
    bestFor: "Hypertrophy accessories and anyone who wants small, sustainable jumps.",
    watchOut: "Stalls hide as 'almost cap' for weeks — enforce the cap honestly.",
    evidence: ["Classic strength-coaching staple", "Israetel / RP hypertrophy"],
  },
  linear: {
    id: "linear",
    name: "Linear progression",
    summary: "Add a fixed load every session until you stall.",
    how: "Same reps, add a fixed increment each session. On a miss, repeat or reset.",
    bestFor: "Novices and early intermediates who recover fast and adapt linearly.",
    watchOut: "Runs out quickly for trained lifters; doesn't autoregulate for bad days.",
    evidence: ["Starting Strength / linear-periodization tradition"],
  },
  "amrap-top-set": {
    id: "amrap-top-set",
    name: "AMRAP top set",
    summary: "A top set taken to a rep-max updates your e1RM, which drives the next prescription.",
    how: "Hit a planned top set as many reps as possible; the reps estimate a fresh 1RM, and next session's loads are re-derived from it.",
    bestFor: "Strength blocks where you want frequent, self-correcting maxes without true singles.",
    watchOut: "AMRAPs are fatiguing and RPE-blind — cap the reps so it doesn't become a weekly contest.",
    evidence: ["Wendler 5/3/1 lineage", "Epley/Brzycki 1RM estimation"],
  },
  "five-three-one": {
    id: "five-three-one",
    name: "5/3/1 (Wendler)",
    summary: "Percentages off a conservative Training Max; TM ratchets up each cycle.",
    how: "Work at 65/75/85 → 70/80/90 → 75/85/95% of a Training Max (90% of true max). Final set is an AMRAP. After each cycle, TM rises +5 lb upper / +10 lb lower.",
    bestFor: "Long, low-stress strength progression for busy intermediates.",
    watchOut: "Set the TM too high and the AMRAPs collapse; the method assumes you leave reps in reserve early.",
    evidence: ["Wendler, 5/3/1 (2nd ed.)"],
  },
  "top-set-backoff": {
    id: "top-set-backoff",
    name: "Top set + back-offs",
    summary: "One heavy top set for intensity, then lighter back-off sets for volume.",
    how: "Work up to a heavy top single/set by RPE, then drop a fixed % for back-off volume. Progress the top set by its RPE.",
    bestFor: "Peaking and strength-skill: exposure to heavy loads plus enough volume to grow.",
    watchOut: "The top set sets the tone — if RPE is off, both the single and the back-offs are mis-loaded.",
    evidence: ["Daily-max / top-set traditions", "Tuchscherer RTS"],
  },
  "compound-hypertrophy": {
    id: "compound-hypertrophy",
    name: "Compound hypertrophy",
    summary: "Volume-biased double progression for big lifts — add reps, then sets, then load.",
    how: "Grow reps to the cap, then add a set before adding load, keeping effective reps high for growth while managing compound fatigue.",
    bestFor: "Compound lifts trained for size rather than a 1RM.",
    watchOut: "Set creep balloons fatigue — respect weekly volume landmarks (MRV).",
    evidence: ["Israetel / RP volume landmarks", "Schoenfeld volume meta-analyses"],
  },
  "drop-set": {
    id: "drop-set",
    name: "Drop set",
    summary: "A top set then immediate load drops to extend the set past failure.",
    how: "Hit the top set to target, strip load, keep going. Progress the top-set load when the target total reps are met cleanly.",
    bestFor: "Time-efficient hypertrophy on machines and isolation work.",
    watchOut: "Very fatiguing per unit time; use sparingly and not on heavy compounds.",
    evidence: ["Schoenfeld (advanced techniques)", "RP technique guidance"],
  },
  calibration: {
    id: "calibration",
    name: "Calibration (RPE estimate)",
    summary: "Estimate your 1RM from submaximal RPE-rated sets — no max-out, no grind.",
    how: "Do the prescribed reps and log the *actual* RPE. The engine back-calculates your 1RM from weight × reps @ RPE (the same RIR→%1RM math used everywhere) and recalibrates future loads off it. The most informative set wins.",
    bestFor:
      "Returning from a layoff, a new movement, or any time you need an e1RM without testing a true max — connective tissue re-acclimates while you dial in the number.",
    watchOut:
      "Only as accurate as your RPE honesty; sets of ~3–8 reps give the tightest estimate (very high reps drift). It calibrates the number, it doesn't drive overload — switch to a progression rule once your maxes are dialed in.",
    evidence: ["Zourdos 2016 (RIR-based RPE)", "Helms 2018 (RPE→%1RM)", "Tuchscherer RTS"],
  },
};
