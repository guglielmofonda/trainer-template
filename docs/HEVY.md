# Hevy integration — live history with a server-owned connection

Most of this app's intelligence is wasted on placeholder numbers. The seed
program ships with *guessed* starting maxes (squat 185 lb, bench 195 lb, …) and
guessed accessory loads. This integration replaces the guesses with **your actual
history**: it pulls your logged workouts from [Hevy](https://hevy.com) via its
public API and turns them into starting weights and plan-tuning recommendations —
all of it traceable, none of it a black box (the project's whole thesis).
Hevy serves weights as kilograms; the app converts them to the program's unit
before showing or applying suggestions, so the app stays in pounds by default.
Program weights are exactly what you log in Hevy: dumbbell lifts are stored per
dumbbell/hand, not as the pair total. A 50 lb chest-supported dumbbell row is
stored and rendered as `50 lb / hand`, then converted to Hevy's kilogram payload
at the API boundary.

It mirrors the engine's architecture: the science is **pure and tested**
(`normalize → match → calibrate → apply`), and only `HevyClient` touches the
network.

## What you get

1. **Starting weights, from your data.**
   - *Main barbell lifts* (max-basis: squat / bench / deadlift / OHP) get an
     **estimated 1RM** computed with the engine's own RPE→%1RM math
     (`estimate1RM`), from a robust "recent best" — the **median of your top few
     single-set e1RMs**, so one fluke set can't inflate the number.
   - *Accessories* (work-basis) get a realistic **starting working weight** — the
     median of your recent sessions' top working set — which the
     double-progression rule then climbs from.
2. **Plan tuning.** Lifts you train hard but that *aren't* in the plan (candidate
   additions); planned lifts with **no history** (kept as placeholders for the
   ramp/calibration block to dial in); a **volume reality-check** of your actual
   weekly sets per muscle against the plan's MEV/MAV/MRV landmarks; and
   stale-data / big-change flags.
3. **Trust surface.** Every suggestion shows the matched Hevy exercise + a match
   score, a confidence (`high`/`medium`/`low`/`none`), the source set(s), and a
   one-line rationale. Backend calibration only applies **high/medium** confidence;
   lower-confidence suggestions stay visible in its report for manual review.

## How it works in the app

The backend owns the Hevy connection through `HEVY_API_KEY`; the athlete never
pastes or imports a key in the app. Progress and Workout review fetch fresh Hevy
data automatically whenever those routes open. The coach's Hevy tools also read
live, so “refresh my Hevy data” can be handled conversationally without a separate
button or setup surface.

If Hevy is temporarily unavailable, the app shows a retryable integration error
without asking the athlete to manage credentials.

### Maintenance calibration from the CLI

Historical calibration changes plan anchors, so it remains a deliberate backend
maintenance operation rather than a user-facing refresh prompt:

```bash
HEVY_API_KEY=xxxx npm run hevy:import              # preview, no writes
HEVY_API_KEY=xxxx npm run hevy:import -- --apply   # write starting weights to data/store.json
```

Flags: `--window=<days>` (default 120), `--seed` (calibrate the bundled seed
program instead of the store's), `--min=high|medium|low` (lowest confidence to
auto-apply, default `medium`).

## The methodology (show your work)

**e1RM from a working set.** `estimate1RM(weight, reps, rpe) = weight ÷ %1RM(reps,
10−rpe)`. A set logged *without* RPE is read **conservatively**: because a lower
RPE implies more reps-in-reserve and therefore a *higher* inferred 1RM, an
un-tagged top set is assumed to be ~RPE 9 (near failure), which biases the
estimate **down, never up**. Sets above 12 reps are ignored for 1RM estimation
(extrapolation error grows with reps). Failure-typed sets are read as RPE 10.

**Why a safe starting weight.** For the main lifts, the seeded e1RM is only a
*starting* anchor — every session you work up to an opening single @ RPE 8 that
**re-calibrates** it on the spot, and the 2-week ramp block re-checks all four
maxes before the real block. For accessories the suggestion is an *observed*
weight you actually lifted, not an extrapolation. So a slightly-off seed
self-corrects fast.

**Matching.** Your program's exercise names rarely equal Hevy's catalog titles
("Back Squat" vs "Squat (Barbell)"). The matcher parses titles into a core-token
set + an equipment set, weights overlap by **IDF** over the exercises you
actually trained (so distinctive tokens like *pulldown* / *romanian* dominate
generic ones like *leg* / *press*), and applies a curated alias table for the
seed lifts with hard `exclude` vetoes (so "Back Squat" can't grab "Front Squat").
Every match is scored 0–1 and shown; below 0.6 it's treated as "no match".

**Confidence.** `high` = a clean match (score ≥ 0.8) with ≥ 3 sessions in the
window; `medium` = a real match with ≥ 2 sessions; `low` = a single session or a
borderline/cross-equipment match; `none` = unmatched (placeholder kept). Only
`high`/`medium` auto-apply. A single session is deliberately *not* enough to
overwrite a starting weight (it's often a one-off variant), so it's surfaced for
review instead. No-RPE max-lift data is capped at `medium`; a cross-equipment
match (e.g. a barbell slot matched only to a dumbbell variant — per-hand vs
total-bar loads aren't comparable) is capped at `low`; stale data (no session in
45 days) drops one level.

## Source of truth & data flow

The **website is the source of truth**. In production, the program and logs live
in a private Vercel Blob; local development uses `data/store.json`, which is also
the production bootstrap snapshot. The flow:

```
  website (private Blob = your program)      ← durable source of truth, edit here
        │
        ├──────── coach / session writes
        │
  GitHub Actions reads the same Blob when its token is configured
        │  daily Action pulls Hevy actuals
        ▼
  analysis (npm run hevy:daily)              ← runs on the website's program
        │                                       + the Hevy actuals
        ▼
  reports/hevy-latest.md (committed back)
```

- **Edit the plan in the app** (Configuration, the session logger, or the coach).
  Production saves automatically to the private Blob. Local development writes
  `data/store.json`; `npm run program:push` can still version that local snapshot.
- **Hevy is pulled automatically for *actuals*** (what you performed), never the
  source of truth. Progress and Workout review read live on open; the coach reads
  live when asked.
- **Analysis runs on the website's program** (`hevy:daily` loads the Blob in CI
  when `BLOB_READ_WRITE_TOKEN` is available, otherwise the bundled snapshot,
  pulls Hevy, and reports volume-vs-landmarks + calibration drift + recent sessions).
  Calibration only *suggests* changes; applying them is a deliberate backend
  maintenance action, so a normal live refresh never overwrites your plan.
- **Compound warm-ups stay distinct from work.** Routine exports prepend the
  prescription's ramp with Hevy set type `warmup`; imports and progression omit
  those sets from working volume while the review/report surfaces still show them
  with a `WU` / **warm-up** label. See [`WARMUPS.md`](./WARMUPS.md).

## Staying in sync (webhook)

Hevy can POST to `/api/hevy/webhook` whenever you save a workout, so the plan can
keep calibrating itself "going forward". To enable it:

1. Set `HEVY_WEBHOOK_SECRET` (any random string) and `HEVY_API_KEY` in your env.
   Optionally set `HEVY_WEBHOOK_AUTO_APPLY=true` to auto-apply confident
   starting-weight updates after each workout (it never touches a *locked*
   program; off by default — otherwise the endpoint just acknowledges and logs).
2. Expose the endpoint publicly — a localhost dev server can't receive Hevy's
   POSTs, so use a tunnel (`ngrok http 3000`) or deploy.
3. Register the URL in Hevy as
   `https://<host>/api/hevy/webhook?token=<HEVY_WEBHOOK_SECRET>`.

The receiver authenticates the secret, returns `200` immediately (well within
Hevy's 5-second budget), and does any recalibration *after* responding via Next's
`after()`. `GET /api/hevy/webhook` is a health check.

## Architecture

```
lib/integrations/hevy/
  types.ts       Hevy API DTOs (exact wire field names)
  client.ts      HevyClient — the only I/O: paginated GETs, 429/5xx backoff, api-key header
  normalize.ts   PURE: workouts → per-exercise performance history
  match.ts       PURE: program lifts ↔ trained Hevy exercises (IDF + alias table)
  calibrate.ts   PURE: history + program → suggestions + recommendations
  apply.ts       PURE: write confident suggestions into a new Program (+ changelog)
  index.ts       importFromHevy() orchestrator + hevyClientFromEnv()
```

Tested in `lib/integrations/hevy/*.test.ts` (matcher disambiguation, e1RM math,
accessory weights, bodyweight handling, recommendations, apply immutability, and
the HTTP client's pagination / window cutoff / retry / auth-error paths).

> Training software, not medical advice. Treat seeded starting weights as a
> ceiling and let the opening single / ramp block recalibrate.
