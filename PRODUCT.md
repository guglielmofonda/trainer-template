# Product

## Register

product

## Users

A serious, self-coaching strength athlete — an intermediate-to-advanced lifter who
programs their own training and trusts numbers over vibes. They understand RPE/RIR,
periodization waves, and volume landmarks (MEV/MAV/MRV), or want to. Two contexts:

- **At a desk**, planning or auditing a multi-week block: reading the whole grid,
  checking weekly volume against landmarks, reasoning about progression rules.
- **In the gym, mid-session**, phone in hand between heavy sets: logging a top
  single, watching the work-set loads re-scale to how strong they are today, and
  reading the engine's "what changes next week" verdict.

The job to be done: *"Tell me exactly what to lift today, and change the plan
intelligently based on what actually happened — and show your work so I trust it."*

The Training coach is one continuous relationship, not a disposable browser
session. Conversations are private, durable, and resumable from any signed-in
device so planning at a desk can continue on a phone in the gym.

## Product Purpose

The trainer is a progressive-overload, periodized strength platform. Its thesis is
explicit: **the engine is the core.** A pure, fully-tested
TypeScript library encodes the training science — periodization waves, e1RM math,
ten named progression rules, and volume analysis against evidence-based landmarks.
The UI is the precision instrument that renders that engine: it makes the math
legible, loggable, and trustworthy.

Success looks like: a lifter opens the app, reads a prescription, logs a session in
seconds, and *believes* the next-week recommendation because the reasoning is on the
surface — not buried, not hand-wavy. The interface should feel like a measurement
instrument for your own strength, not a fitness-app toy.

## Brand Personality

Precise, grounded, quietly confident. The voice of a strong coach who shows their
work: direct, quantitative, never hype. Three words: **instrument, evidence,
restraint.** It should evoke trust and focus — the calm of a well-built tool that
disappears into the task — not motivation-poster energy, not gamified dopamine.

## Anti-references

- **Consumer fitness apps** (Strava/Fitbit/Peloton gloss): badges, streak
  confetti, motivational gradients, hero photography of athletes. This is a
  workbench, not a hype machine.
- **The 2026 AI-SaaS default**: emerald-on-black, system-font, rounded-card grids,
  the hero-metric template, gradient text, glassmorphism. If it looks auto-generated
  from "dark dashboard," it's wrong.
- **Spreadsheet bleakness**: the data is dense, but it must not feel like raw Excel.
  Hierarchy, rhythm, and a real typographic system separate this from a gray grid.

## Design Principles

1. **The numbers are the hero.** Loads, reps, RIR, e1RM, intensity, and volume are
   the product. They get a first-class typographic system (tabular mono) and the
   strongest position in any layout. Everything else supports them.
2. **Show the work.** Every prescription and every progression decision should be
   traceable to its reasoning (the rule, the evidence, the landmark). Trust is the
   feature; never present a number as a black box.
3. **Dense, but never noisy.** This audience wants information density. Earn it with
   hierarchy and alignment, not by hiding data behind clicks.
4. **Instrument, not toy.** Restraint over decoration. Color, motion, and emphasis
   are reserved for state and meaning (effort, progress, warnings), never garnish.
5. **Honest about its limits.** Volume landmarks are guidelines, not laws; the coach
   degrades gracefully without an API key. Surface these truths plainly rather than
   pretending certainty.

## Accessibility & Inclusion

- Target **WCAG 2.1 AA**: body text ≥ 4.5:1, large/UI text ≥ 3:1, visible
  focus states on every interactive control, full keyboard operability.
- **Color is never the only signal** — volume verdicts and progression outcomes
  always carry a text label and/or icon alongside hue (matters for the red/green
  verdicts and color-blind users).
- **Respect `prefers-reduced-motion`**: every transition and reveal has a
  reduced/instant alternative.
- Numeric inputs use appropriate `inputMode` for fast mobile entry mid-session.
