import { promises as fs } from "node:fs";
import path from "node:path";

export interface BlockState {
  block: string;
  currentWeek: number;
  startDate: string;
  lastAdvancedISO: string | null;
}

const STATE_FILE = path.join(process.cwd(), "data", "state.json");

export async function readBlockState(): Promise<BlockState> {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8")) as BlockState;
  } catch {
    return { block: "ramp", currentWeek: 1, startDate: new Date().toISOString().slice(0, 10), lastAdvancedISO: null };
  }
}

export function writeBlockState(state: BlockState): Promise<void> {
  return fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}
