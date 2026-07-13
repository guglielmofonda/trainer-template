# The theory — why this engine is built the way it is

> This is the core of the project. The UI, the database, and the AI coach are
> thin shells around one idea: **encode the decisions a good strength coach makes
> into a small, testable, deterministic engine.** Everything below maps directly
> to code in `lib/engine/`.

The platform answers two questions, every week, for every exercise:

1. **What weight should I lift today?** (the *prescription*)
2. **What changes next week?** (the *progression*)

A spreadsheet can answer #1 if you fill it in by hand. The hard, interesting part
is doing both *automatically and correctly* from how your last sessions actually
went. That is autoregulation, and it's the reason this is software and not a
Google Sheet.

---

## 1. Progressive overload — the only thing that matters

Muscles adapt to a stress only if the stress keeps rising. Hold the weight, sets,
and reps constant and adaptation plateaus. So every program must make the work
*progressively harder* over time — more load, more reps, more sets, or less rest.
This is **progressive overload**, and it is the single non-negotiable principle of
strength training.

The engine expresses "harder" along three axes that it can manipulate
independently:

| Axis | In the engine | Direction over a cycle |
|---|---|---|
| **Load** (intensity) | `WeekPlan.intensity`, `e1rm` | rises (easy → heavy singles) |
| **Proximity to failure** | `WeekPlan.rir` (reps in reserve) | falls (3 RIR → 1 RIR → 0) |
| **Volume** | `WeekPlan.sets`, reps | managed against landmarks |

The art is raising one axis while holding the others, so fatigue accumulates
slower than fitness. That sequencing is *periodization* (§4).

---

## 2. RPE, RIR, and the one chart everything rests on

You cannot autoregulate without a language for *effort*. Two equivalent scales:

- **RPE** (Rate of Perceived Exertion), 1–10. RPE 10 = could not do another rep.
- **RIR** (Reps In Reserve) = `10 − RPE`. "Stop with 2 in the tank" = 2 RIR = RPE 8.

The empirical fact that makes the math work (Tuchscherer's RPE chart, validated by
Helms et al. 2018): **the fraction of your 1-rep max you can lift depends almost
entirely on how many reps you have left in the tank, not on the specific
reps×RPE split.** A set is fully described by its *rep-max equivalent*:

```
effectiveReps = reps performed + reps in reserve
```

5 reps stopped at 2 RIR sits at the same %1RM as a true 7-rep max — in both cases
the bar is loaded to what you could do 7 times. So a 2-D table (reps × RPE)
collapses to a 1-D curve indexed by `effectiveReps`. That curve is
`RPE10_PERCENT[]` in [`lib/engine/e1rm.ts`](../lib/engine/e1rm.ts):

| n-rep max | %1RM | | n-rep max | %1RM |
|---|---|---|---|---|
| 1 | 100% | | 6 | 83.7% |
| 2 | 95.5% | | 8 | 78.6% |
| 3 | 92.2% | | 10 | 73.9% |
| 4 | 89.2% | | 12 | 69.6% |
| 5 | 86.3% | | 15 | 63.6% |

From this one table the engine derives everything:

- `percentOf1RM(reps, rir)` → the %1RM target for a prescription.
- `estimate1RM(weight, reps, rpe)` → infer a 1RM from *any* set you logged.
- `e1rmFromSingle({weight, rpe})` → infer today's max from an opening single
  (a single @ RPE 8 = the 3-rep-max %, ≈ 92%).

---

## 3. Two layers of autoregulation

This is the heart of the system, and exactly what Matt demonstrates in the video.

### Layer A — within the session: the opening single

For the main compounds, instead of trusting a 1RM you set weeks ago, you **work up
to one heavy single at a target RPE (usually 8)** at the start of the session. That
single tells the engine how strong you are *today*:

```
dailyE1RM = singleWeight / %1RM(1 rep, RIR = 10 − singleRPE)
```

The work sets are then prescribed off that fresh number:

```
workingLoad = dailyE1RM × %1RM(weekReps, weekRIR)   →  rounded to the bar
```

Feel strong, hit 415 on the single → the work sets get heavier. Feel beat up, only
manage 375 → they get lighter. Same code path, opposite outcomes — this is
[`prescribe()`](../lib/engine/prescription.ts) with `loadBasis: "max"`. It is *literally*
the moment in the video where changing the single from 375 to 455 walks the
prescription up and down.

### Layer B — between sessions: completed work decides next week

How hard the *work sets* went decides what next week looks like. The
default for compounds is **set-threshold RIR**: do sets at the prescribed load,
stopping each set the instant you hit the RIR cutoff; count how many *quality* sets
you completed. Hit the set cap → add load and reset reps. Fall short → hold and
repeat. That decision is the progression *rule* (§5), and it is why logging "I got
4 of 4 sets" produces "+10 lb, reps reset" next week.

Accessories don't use a daily single; their load is a working weight times the
week's planned multiplier, and their rule (usually double progression) grows reps
to a cap before adding load.

### Layer C — onboarding: the 2-week calibration ramp

The same RPE↔%1RM math solves a cold-start problem: *what loads do you use when you
don't know your maxes and your joints aren't ready to test them?* The seeded
**ramp-up block** ([`rampProgram()`](../lib/domain/seed.ts)) runs two weeks of submaximal,
higher-rep full-body work — ~3×8 @ RPE 6 climbing to ~3×5 @ RPE 7 on the main lifts — under
the **`calibration` rule**: you log the *actual* RPE on each top set and the engine
back-calculates your e1RM from `estimate1RM(weight, reps, rpe)`. No max-out, no grind — the
connective tissue re-acclimates (tendon remodels slower than muscle) while the number
converges. A set that felt easier than planned nudges the estimate up; harder nudges it down.
After two weeks you carry dialed-in maxes into the main block. Volume is deliberately low
(adaptation, not growth), so several muscles sit at *maintenance* on the planning check —
that's intended, not a misconfiguration.

### Before every big compound: a marked warm-up ramp

Squats, presses, deadlifts, and their major variants receive progressive,
movement-specific warm-up sets before the opening single or work sets. The ramp
starts with the empty bar (75 lb for the first deadlift pull), moves through
roughly 60% of the target, and finishes with a short primer around 80%. Repetitions fall as load
rises so rehearsal does not become fatigue. These sets are explicitly marked in
Hevy and excluded from working volume and progression. The protocol, its
calibration, evidence, and evidence limits live in
[`docs/WARMUPS.md`](./WARMUPS.md).

---

## 4. Periodization — sequencing easy → hard

A cycle here is **`weeksOn` training + `weeksOff` deload, repeated `mesocycles`
times** (Matt's default: 6 on / 1 off × 3 = 21 weeks). Within that skeleton, each
exercise carries a **wave** that turns into a week-by-week table in
[`lib/engine/periodization.ts`](../lib/engine/periodization.ts).

The default shape is **wave (undulating) periodization** — a sawtooth:

- Inside each ~3-week micro-wave, reps fall, RIR drops, and load climbs.
- Each new micro-wave **resets reps and RIR back up** a notch and bumps the
  baseline load — so RIR is a sawtooth (e.g. 3→2.5→1.5, then back up) that drifts
  gently toward failure across the cycle, not a single monotone slide. That matches
  the source's late-week table, where RIR jumps back up at each new wave.
- Across the whole cycle the program ramps from high-rep / submaximal / light to
  **heavy singles at the configured peak intensity** in the final training week.
- Deloads (half the volume, light, well shy of failure) sit between mesocycles so
  fatigue dissipates before the next, harder block.

This reproduces the back-squat table from the video *exactly* for the first wave
(reps 6/5/4, RIR 3/2.5/1.5, intensity 1.04/1.06/1.08×) and lands the last week on a
true single — verified in
[`periodization.test.ts`](../lib/engine/periodization.test.ts). The lineage is the
block/undulating programming popularized by Nippard, Israetel (RP), and the
Stronger By Science crew.

Why wave instead of straight linear? Because pure linear progression (add 5 lb
every week) runs out fast for trained lifters and ignores bad days. Undulating the
stimulus lets you accumulate volume in the high-rep weeks and express strength in
the low-rep weeks while managing fatigue — you get more productive exposures before
stalling.

---

## 5. The progression rules — a menu of evidence-based methods

Different lifts and goals want different progression logic. Each rule is a small,
named policy in [`lib/engine/rules/`](../lib/engine/rules/) with a `next(result)`
function and an evidence card (`metadata.ts`). The same menu the video shows:

| Rule | What decides next week | Reach for it on |
|---|---|---|
| **Set-threshold RIR** | # of quality sets before the RIR cutoff | main compounds; quality volume without a rep-out |
| **Last-set RIR** | RIR of the final set | accurate RPE-raters wanting simple tuning |
| **Reps to failure** | AMRAP reps beyond target | accessories where failure is safe & potent |
| **Double progression** | reps grown to a cap, then +load & reset | hypertrophy accessories; small sustainable jumps |
| **Linear** | did all sets → +fixed load | novices / fast adapters |
| **AMRAP top set** | a rep-max top set updates e1RM | strength blocks, self-correcting maxes |
| **5/3/1 (Wendler)** | %s off a Training Max; AMRAP bumps TM | long, low-stress strength |
| **Top set + back-offs** | top-set RPE drives the heavy single | peaking, strength-skill |
| **Compound hypertrophy** | reps → cap → add a *set* → then +load | big lifts trained for size |
| **Drop set** | top set hits target cleanly → +load | time-efficient isolation work |
| **Calibration (RPE estimate)** | a submaximal RPE-rated top set → e1RM, no failure | returning from a layoff / unknown maxes (the 2-week ramp, §3) |

The science behind the defaults — and a place the literature is easy to overstate:
**proximity to failure is a real but *small* hypertrophy lever, and it is essentially
not a strength lever.** The meta-analysis (Refalo 2023) puts the hypertrophy advantage
of training closer to failure at a trivial-to-small effect (≈0.15–0.19 SMD, lower bound
near zero) with diminishing returns as you reach true failure; for *strength*, how close
you grind makes little difference, and the very-close end can even cost you through
accumulated fatigue. Strength is driven mainly by **load and total quality volume**, not
by chasing the last rep. What *is* steeply non-linear is the **fatigue**: the rep right
before failure costs far more than the third-to-last for only a sliver more stimulus
(Refalo 2023; Schoenfeld & Grgic). Set-threshold RIR is the engine's answer — capture
most of the stimulus by repeating quality reps at a fixed *submaximal* cutoff (~1–3 RIR),
and let the *number of sets you can sustain at that cutoff*, not a max-effort rep-out,
drive the load. That's why deadlifts and other high-fatigue lifts use conservative cutoffs.

---

## 6. Volume landmarks — how much is enough (and too much)

Load and proximity-to-failure decide intensity; **weekly hard sets per muscle**
decide volume. The engine grades each muscle against
landmarks (after Israetel / Renaissance Periodization),
in [`lib/domain/muscles.ts`](../lib/domain/muscles.ts):

- **MEV** — Minimum Effective Volume: the smallest dose that still grows.
- **MAV** — Maximum Adaptive Volume: the productive working range.
- **MRV** — Maximum Recoverable Volume: the ceiling before fatigue outpaces recovery.

The **planning check** ([`analysis.ts`](../lib/engine/analysis.ts)) sums working sets
per muscle for a week, computes each muscle's share of total volume, and flags
anything below MEV (under-dosed) or above MRV (likely to outrun recovery). On the
seeded full-body program it reads **83 sets / 857 reps** in week 1 with every muscle
landing in its productive band (≥ MEV, ≤ MRV) — run `npm run engine:demo` to print it.

---

## 7. Deloads and the long game

Hard training generates fatigue that masks fitness. Left unchecked it compounds into
stalled lifts, bad joints, and lost motivation. The cycle's built-in deload weeks
(and the `weeksOff` parameter) exist to **dissipate fatigue so the next block can be
harder than the last** — the staircase only goes up because you periodically let it
settle. The engine's deload prescribes ~half the volume at reduced load and high
RIR: enough to maintain, not enough to dig a deeper hole.

---

## 8. The coach — "all this training is, is context"

Once the program, the prescriptions, the logs, and the volume analysis are all
structured data, an LLM coach is just *that context plus a question*. The coach
([`lib/coach/`](../lib/coach/)) assembles a faithful brief — this week's
prescriptions per day, the volume verdicts, recent logs, and the evidence cards for
the rules in play — and hands it to Claude Opus 4.8 to answer questions like "what
should I watch this week?" or "today's single felt heavy — what do I do?". The model
doesn't invent training science; it reasons over *your* numbers. With no API key it
degrades to a deterministic read of the same data, proving the grounding is real
independent of the model.

---

## References & lineage

- Helms, Cross, Brown, Storey, Cronin, Zourdos (2018) — *Application of the RIR-based RPE
  scale for resistance training.* Grounds the RPE→%1RM table in §2.
- Zourdos et al. (2016) — *Novel RIR-based RPE scale.* Validates the RPE↔RIR mapping used
  throughout (RIR = 10 − RPE) — i.e. the *scale*, **not** the %1RM load table (that curve is
  the Tuchscherer / RTS / Helms lineage cited in §2).
- Refalo et al. (2023) — *Proximity to failure & hypertrophy.* Closer-to-failure is a
  **small** hypertrophy lever (≈0.15–0.19 SMD, lower bound ≈ 0) with steeply rising fatigue
  cost, and is **neutral-to-negative for strength** — the basis for the submaximal RIR cutoffs (§5).
- Schoenfeld & Grgic — *Volume–hypertrophy dose-response; training to failure.*
- Schoenfeld, Grgic & Krieger (2019) — *Resistance-training frequency meta-analysis.* With
  weekly volume equated, frequency is ~neutral for growth — the rationale for distributing
  volume across full-body sessions on a fixed-day-count week.
- Israetel / Renaissance Periodization — *MEV / MAV / MRV volume landmarks* (§6).
- Wendler — *5/3/1* (the `five-three-one` rule).
- Stronger By Science (Nuckols et al.) — *autoregulation & program design.*
- Programming style: Jeff Nippard, Mike Israetel, and the SBS bundle (cited in-app).

> Note on scope: Prilepin's table (intensity × reps load guidance) influenced the
> conservative-cutoff philosophy but is **not** encoded as a literal table in the engine, so
> it's intentionally left off the list above rather than cited as if it were implemented.

> Disclaimer: this is training software, not medical advice. Landmarks and charts
> are population guidelines, not laws — the engine exposes them so an informed
> lifter (or the coach) can reason about them, not to replace coaching judgment.
