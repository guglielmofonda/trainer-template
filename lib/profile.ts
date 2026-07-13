import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Athlete/brand profile — the single place personal identity lives.
 *
 * `data/profile.json` is written once during onboarding (see AGENT.md) and
 * committed: like the program store, it is part of this repo's source of truth.
 * A fresh clone has no profile file and runs on the defaults below, so nothing
 * breaks before onboarding.
 */
export interface Profile {
  /** The athlete's name — used in Hevy routine folders and reports. */
  athleteName: string;
  /** App display name — sidebar brand, page titles, login screen. */
  appName: string;
  /** 1–2 characters for the brand mark (usually the athlete's initials). */
  monogram: string;
  /** Small line under the brand name in the sidebar. */
  tagline: string;
}

const DEFAULTS: Profile = {
  athleteName: "Athlete",
  appName: "Trainer",
  monogram: "Tr",
  tagline: "progressive overload",
};

const PROFILE_FILE = path.join(process.cwd(), "data", "profile.json");

/** Server-only (uses fs). Read per call so edits show up without a rebuild. */
export function getProfile(): Profile {
  try {
    const raw = JSON.parse(readFileSync(PROFILE_FILE, "utf8")) as Partial<Profile>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return DEFAULTS;
  }
}
