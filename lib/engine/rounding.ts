import type { RoundingConfig } from "./types";

/** Round a weight to the nearest loadable increment (e.g. 5 lb / 2.5 kg). */
export function roundWeight(weight: number, cfg: RoundingConfig): number {
  const { increment, mode } = cfg;
  if (increment <= 0) return weight;
  const q = weight / increment;
  const n =
    mode === "floor" ? Math.floor(q) : mode === "ceil" ? Math.ceil(q) : Math.round(q);
  // Avoid floating point dust like 319.99999.
  return Math.round(n * increment * 1000) / 1000;
}

export const DEFAULT_ROUNDING_LB: RoundingConfig = { increment: 5, mode: "nearest" };
export const DEFAULT_ROUNDING_KG: RoundingConfig = { increment: 2.5, mode: "nearest" };
