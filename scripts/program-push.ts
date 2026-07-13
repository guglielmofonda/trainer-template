/**
 * Push the website's source of truth (data/store.json — your program + logs) to
 * GitHub, onto `main` where the daily analysis Action reads it.
 *
 *   npm run program:push
 *
 * The store is the canonical plan; Hevy is pulled for actuals; analysis runs on
 * this. This command is how the "website → GitHub" hop happens.
 */
import { execFileSync } from "node:child_process";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

try {
  git(["add", "data/store.json"]);

  // Commit only when the store actually changed (diff --cached --quiet throws on changes).
  let committed = false;
  try {
    git(["diff", "--cached", "--quiet", "--", "data/store.json"]);
  } catch {
    git(["commit", "-m", "chore(program): sync website source of truth"]);
    committed = true;
  }

  // Integrate the Action's report commits, then publish to the feature branch and main.
  git(["fetch", "origin", "main"]);
  try {
    git(["rebase", "origin/main"]);
  } catch {
    git(["rebase", "--abort"]);
    throw new Error("Local history diverged from origin/main — resolve manually, then re-run.");
  }
  git(["push", "-f", "origin", "HEAD"]);
  git(["push", "origin", "HEAD:main"]);

  console.log(committed ? "✓ Program pushed to GitHub (main)." : "✓ No program changes — already in sync with main.");
} catch (err) {
  console.error(`program:push failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
