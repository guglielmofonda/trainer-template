# AGENT.md — onboarding runbook

You are a coding agent (Claude Code, Cursor, Codex, …) opened inside a fresh
copy of this template. Your job is to take the athlete from *cloned repo* to
*fully personalized, deployed training platform*. Work through the phases in
order, interviewing the athlete as you go. The athlete says something like
"onboard me" — this file is the script.

Read `README.md` first for what the product is, and `docs/THEORY.md` if the
athlete asks *why* the engine does anything.

## Ground rules

- **Never commit secrets.** API keys live in `.env.local` (gitignored) locally
  and in Vercel / GitHub Actions settings in production. If you see a key in a
  diff, stop.
- **Dry-run first.** Every Hevy-writing command supports a preview; run it and
  show the athlete before applying (`npm run hevy:import` previews by default;
  pass `--apply` only after confirmation).
- **Ask, don't assume.** Name, schedule, and starting weights come from the
  interview below — never invent them.
- **Commit as you go.** `data/profile.json` and `data/store.json` are this
  repo's source of truth — after each phase that changes them, commit. The repo
  *is* the athlete's database; that's the design.
- **Conservative loads.** If the athlete is unsure of a max, start light. The
  engine autoregulates upward quickly; it cannot un-injure anyone.

## Phase 0 — Preflight

```bash
node -v        # needs 20+
npm install
npm test       # full suite must pass before you touch anything
npm run engine:demo
```

If tests fail on a fresh clone, stop and debug before onboarding.

## Phase 1 — Interview the athlete

Ask (conversationally, not as a form):

1. **Name** — and what they want the app to be called (default: "<Name>'s
   trainer" or just "Trainer").
2. **Schedule** — how many days per week, and which days (e.g. Mon/Thu/Sat).
3. **Experience** — have they run the big compounds (squat/bench/deadlift/press)
   before? Any injuries or movements to avoid?
4. **Starting numbers** — known 1RMs, recent top sets, or nothing (all fine;
   the engine estimates from an opening single and recalibrates from Hevy
   history later).
5. **Units** — the seed program is lb; the engine supports kg per program.
6. **Integrations** — do they use [Hevy](https://hevy.com) (Pro needed for the
   API)? Do they want the conversational AI coach (needs an Anthropic API key)?

## Phase 2 — Personalize the identity

Write `data/profile.json` (all names in the UI, Hevy folders, and reports read
from this file; defaults apply to any field you omit):

```json
{
  "athleteName": "Ada",
  "appName": "Ada trainer",
  "monogram": "Ad",
  "tagline": "progressive overload"
}
```

Then update the favicon to match: edit `app/icon.svg` and replace the `Tr`
text content with the same monogram. Commit both files.

## Phase 3 — Build their program

```bash
npm run dev   # http://localhost:3000
```

- The app self-seeds `data/store.json` with the reconstructed program from the
  video the README credits — treat it as a worked example, not a prescription.
- Open **Configuration** and rebuild it for the athlete: cycle structure
  ("6 on / 1 off · 3 mesos" is the reference shape), their training days, their
  exercises with estimated 1RMs, a periodization *wave* and progression *rule*
  per lift (the rule cards explain the evidence).
- Watch the **planning check**: weekly sets per muscle should mostly land
  "productive" against the MEV/MAV/MRV landmarks. Fix gross under/overshoots
  now — the engine progresses volume from wherever you start it.
- New or returning lifters: prefer autoregulated rules (opening single @ RPE 8)
  over fixed percentages — detrained maxes are unknowns, not facts.
- When the athlete is happy, commit `data/store.json` (and `data/state.json`
  once it exists).

## Phase 4 — Hevy (optional but the point of the automation)

1. Key: hevy.com → Settings → API (requires Hevy Pro). Put it in `.env.local`
   as `HEVY_API_KEY=...`. The server owns this key; the UI never asks for it.
2. Verify read access: `npm run hevy:import` (preview only — shows what it
   *would* calibrate from their history; `-- --apply` writes it).
3. Push the program to Hevy as routines: `npm run hevy:export` (check its
   `--help` header comment; do a dry run first, then confirm with the athlete
   before writing). Warm-up ramps export as `warmup` sets — they never count
   as working volume.
4. From here the athlete trains *from Hevy*; the app reads actuals back
   automatically wherever a `HEVY_API_KEY` is configured.

## Phase 5 — The AI coach (optional)

Add `ANTHROPIC_API_KEY=...` to `.env.local` (console.anthropic.com). Without
it the coach still works in a deterministic mode that reads the real program,
logs, and volume analysis — just not conversationally.

## Phase 6 — Deploy

Vercel is the primary path (the README's Hosting section covers alternatives):

1. Push the repo to the athlete's GitHub (a template copy is already theirs).
2. [vercel.com/new](https://vercel.com/new) → import the repo. Zero build config
   needed.
3. Environment variables (Project → Settings → Environment Variables):
   - `APP_PASSWORD` — **required**; the login gate is enforced on Vercel so the
     athlete's training data isn't public. Generate one:
     `openssl rand -base64 18`.
   - `APP_SESSION_SECRET` — recommended; another random value.
   - `ANTHROPIC_API_KEY`, `HEVY_API_KEY` — if configured in Phases 4–5.
4. Storage: connect a **Blob** store (Project → Storage → Create → Blob). This
   injects `BLOB_READ_WRITE_TOKEN`; production writes (program edits, logs,
   coach conversations) need it because the serverless filesystem is ephemeral.
5. Verify: open the deployment, log in with `APP_PASSWORD`, edit something in
   Configuration, redeploy, confirm the edit survived (that proves Blob writes).

## Phase 7 — Automation (GitHub Actions)

Two scheduled workflows keep the repo (source of truth) current:

- `.github/workflows/hevy-daily.yml` — daily Hevy pull; commits
  `reports/hevy-latest.md` + `data/hevy-history.json`.
- `.github/workflows/weekly-push.yml` — Sunday-night progression: advances the
  program and pushes next week's routines to Hevy. Holds if the athlete didn't
  train; stops at block end.

Setup:

1. Repo → Settings → Secrets and variables → Actions → add `HEVY_API_KEY`
   (and `BLOB_READ_WRITE_TOKEN` if the website should be read as source of
   truth rather than the repo snapshot).
2. Actions tab → enable workflows (GitHub ships them disabled on new
   template copies).
3. Adjust the two `cron:` lines to the athlete's timezone — the defaults
   assume US Pacific evenings. Cron is UTC.
4. Trigger each once manually (Actions → workflow → Run workflow) and read the
   run summary with the athlete.

Optional webhook (instant instead of daily): set `HEVY_WEBHOOK_SECRET` in
Vercel, then register `https://<host>/api/hevy/webhook?token=<secret>` at Hevy.
`HEVY_WEBHOOK_AUTO_APPLY=true` opts into automatic recalibration.

## Phase 8 — Handover

Finish by telling the athlete, concretely:

- What was configured (profile, program summary, which integrations are live).
- The weekly rhythm: train from Hevy → daily pull writes the report → Sunday
  advance progresses loads → repeat. Where to *see* each of those.
- What they log manually in the app (opening singles + work sets on session
  day) vs what flows in automatically.
- Where the secrets live and that nothing sensitive is in git.
- That `npm test` is the contract: run it after any engine change.

## Troubleshooting quick refs

- Coach says offline → no `ANTHROPIC_API_KEY` in the running environment.
- Progress/Review pages empty → no `HEVY_API_KEY`, or no workouts in window.
- Production edits vanish after redeploy → Blob store not connected.
- Actions fail on push → workflow permissions: repo → Settings → Actions →
  General → Workflow permissions → "Read and write".
- Login loop on Vercel → `APP_PASSWORD` unset (the gate is enforced there).
