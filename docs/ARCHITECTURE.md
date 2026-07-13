# Architecture

The design goal: keep the training *theory* in one pure, testable place and make
everything else a replaceable shell around it. Layers, inside → out:

```
            ┌────────────────────────────────────────────────────────┐
            │  lib/engine/   PURE ENGINE (no I/O, no framework)        │
            │  ───────────────────────────────────────────────        │
            │  e1rm · rounding · calendar · periodization ·           │
            │  prescription · rules/ · analysis                        │
            │  → fully unit-tested against the video's ground truth    │
            └───────────────▲───────────────────────▲────────────────┘
                            │                       │
        ┌───────────────────┴──────┐    ┌───────────┴───────────────┐
        │  lib/domain/             │    │  lib/store/  (persistence)│
        │  seed program + muscle   │    │  Store interface +         │
        │  volume landmarks        │    │  FileStore / BlobStore     │
        └───────────────▲──────────┘    └───────────▲───────────────┘
                        │                            │
            ┌───────────┴──────────┐     ┌───────────┴───────────────┐
            │  lib/coach/          │     │  app/  (Next.js App Router)│
            │  context + Claude    │     │  server components,        │
            │  (Opus 4.8) coach    │     │  server actions, /api      │
            └──────────────────────┘     └────────────────────────────┘
```

## The engine boundary

`lib/engine/index.ts` is the only surface the rest of the app imports. The engine:

- takes plain data in (`Program`, `Exercise`, `WeekPlan`, `SessionResult`),
- returns plain data out (`Prescription`, `ProgressionDecision`, `PlanningCheck`),
- never touches the network, filesystem, clock, or React.

That purity is why the science can be tested in 25 fast unit tests with zero mocks,
and why the same engine could back a CLI, a mobile app, or a Convex deployment
unchanged. `Date.now()` lives only in the UI/actions layer and is passed *into* the
engine, never read by it.

## Data flow for the two core operations

**Prescription (read):** a server component calls `dayWeekView(program, dayId,
week)` → for each exercise it builds the `WeekPlan` from the wave
(`generateWeekPlans`) and resolves a concrete `Prescription` (`prescribe`). For
"max"-basis lifts the session UI re-runs `prescribe()` client-side as you type the
opening single — the engine is small enough to ship to the browser.

**Progression (write):** the `logSession` server action
([`app/actions.ts`](../app/actions.ts)) loads the program, calls
`applySession(...)` to get the `ProgressionDecision` + next-week preview, appends a
`SessionLog` via the `Store`, and returns the decision to the client.

## Persistence — swappable by design

Everything goes through the [`Store`](../lib/store/types.ts) interface. Local
development uses `FileStore`, which writes `data/store.json` with
zero setup. Vercel production uses `BlobStore`, backed by a private Blob store and
seeded from the bundled `data/store.json` on first read. Blob writes use ETag
compare-and-swap retries so separate function instances cannot silently overwrite
each other. Programs, logs, and Training coach conversations therefore survive
deployments and are shared across authenticated devices. A different backend
(Convex/Postgres/etc.) only needs to implement the same interface — no engine or UI
changes.

## The coach — grounding over a model, plus hands

`lib/coach/context.ts` serializes "all the context" (program, this week's
prescriptions, volume verdicts, recent logs, and the evidence cards for the rules in
play) into a brief. `coach.ts` runs a multi-turn **agentic loop** on Claude Opus 4.8
(adaptive thinking, prompt-cached system prefix): the model streams text and calls
tools; the loop executes them and feeds results back until the answer is done.

The tool harness lives in `lib/coach/tools.ts` — one JSON-Schema definition + one
zod-validated executor per tool, all running against an injectable
`CoachToolContext` (store, clock, block state, Hevy fetch), so the whole surface is
testable offline:

- **Reads** — `get_schedule` (date math, block week, what's logged), `get_program`,
  `get_day_prescriptions`, `get_week_volume`, `get_recent_logs`,
  `get_progression_rules`, and live Hevy: `get_hevy_workouts`,
  `list_hevy_routines`, `get_progress_snapshot`.
- **Writes (local plan)** — `update_program` (atomic edit ops: exercise fields/wave,
  add/remove/move exercises, rename/add/remove/reorder days; respects the lock),
  `set_program_lock`, `log_session` (runs the progression engine).
- **Hevy write** — `push_to_hevy`, dry-run by default; `push:true` creates or
  updates routines (marker-matched `[day-id]` titles, optional `dayIds` subset and
  per-day date labels). The system prompt enforces dry-run-then-push and user
  consent (a message like "adjust X, then push to Hevy" pre-authorizes).

`app/api/coach/route.ts` owns durable conversation history, then streams NDJSON
events (`text`, `tool_start`, `tool_end`, `error`, `done`) that
`components/CoachChat.tsx` renders as chat text plus tool activity chips. User turns
are saved before the model runs and completed coach replies are appended before the
stream closes, so a refresh or another authenticated device can resume the same
thread. The route also revalidates pages after mutating tools. The system prompt
forbids inventing numbers, so the model reasons over *your* data. No key → a
deterministic engine-derived answer, proving the grounding is real without the LLM.
`lib/coach/tools.test.ts` covers every executor; `lib/coach/agent.test.ts` drives
the loop with a scripted model, including the full "restructure two back-to-back
days, then push to Hevy" scenario against a fake Hevy API.

## Why these technology choices

- **Pure TS engine** — the IP is the algorithms; isolating them makes them
  provable and portable. This is the single most important decision in the repo.
- **Next.js App Router + server actions** — server components read the store
  directly (no API boilerplate); the one genuinely interactive surface (the session
  logger) is a client component that reuses the same engine.
- **Local JSON + durable production Blob** — local work stays inspectable and
  zero-setup, while hosted writes survive stateless function instances. The
  interface remains small enough to move to Convex/Postgres later.
- **Tailwind v4** — dark, dense, spreadsheet-like UI matching the source.

## Testing strategy

`lib/engine/*.test.ts` assert the engine against **ground truth captured from the
video** (`/.context/RESEARCH_NOTES.md`): the exact first-wave periodization table,
the opening-single autoregulation direction, the set-threshold "+10, reps reset"
decision, and that the planning check sums correctly. Run `npm test`.
