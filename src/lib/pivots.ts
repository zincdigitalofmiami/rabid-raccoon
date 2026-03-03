/**
 * Traditional (Floor) Pivot Point calculation.
 *
 * Formula (same as TradingView / Pine ta.pivot_point_levels("Traditional")):
 *   PP = (H + L + C) / 3
 *   R1 = 2*PP - L        S1 = 2*PP - H
 *   R2 = PP + (H - L)    S2 = PP - (H - L)
 *   R3 = 2*PP + (H-2L)   S3 = 2*PP - (2H-L)
 *   R4 = 3*PP + (H-3L)   S4 = 3*PP - (3H-L)
 *   R5 = 4*PP + (H-4L)   S5 = 4*PP - (4H-L)
 */

export interface PivotLevels {
  pp: number;
  r1: number;
  s1: number;
  r2: number;
  s2: number;
  r3: number;
  s3: number;
  r4: number;
  s4: number;
  r5: number;
  s5: number;
}

export function calculateTraditionalPivots(
  high: number,
  low: number,
  close: number,
): PivotLevels {
  const pp = (high + low + close) / 3;
  const range = high - low;

  return {
    pp,
    r1: pp * 2 - low,
    s1: pp * 2 - high,
    r2: pp + range,
    s2: pp - range,
    r3: pp * 2 + (high - 2 * low),
    s3: pp * 2 - (2 * high - low),
    r4: pp * 3 + (high - 3 * low),
    s4: pp * 3 - (3 * high - low),
    r5: pp * 4 + (high - 4 * low),
    s5: pp * 4 - (4 * high - low),
  };
}

/** Timeframe label prefix (D, W, M, Y) */
export type PivotTimeframe = "D" | "W" | "M" | "Y";

/** A single pivot line for chart rendering */
export interface PivotLine {
  timeframe: PivotTimeframe;
  level: string; // "P", "R1", "S1", etc.
  label: string; // "D(P)", "W(R1)", etc.
  price: number;
  /** Unix seconds (UTC) where this pivot segment starts on chart. */
  startTime?: number;
}

/** All levels as an ordered array for chart rendering */
const LEVEL_KEYS: Array<{ key: keyof PivotLevels; label: string }> = [
  { key: "pp", label: "P" },
  { key: "r1", label: "R1" },
  { key: "s1", label: "S1" },
  { key: "r2", label: "R2" },
  { key: "s2", label: "S2" },
  { key: "r3", label: "R3" },
  { key: "s3", label: "S3" },
  { key: "r4", label: "R4" },
  { key: "s4", label: "S4" },
  { key: "r5", label: "R5" },
  { key: "s5", label: "S5" },
];

/**
 * Convert PivotLevels into an array of PivotLine objects for rendering.
 * @param levels  The calculated levels
 * @param tf      The timeframe prefix
 * @param maxLevel  Maximum R/S level to include (1-5). Default 5 (all).
 */
export function pivotLevelsToLines(
  levels: PivotLevels,
  tf: PivotTimeframe,
  maxLevel: number = 5,
): PivotLine[] {
  return LEVEL_KEYS.filter(({ label }) => {
    if (label === "P") return true;
    const num = parseInt(label.slice(1), 10);
    return num <= maxLevel;
  }).map(({ key, label }) => ({
    timeframe: tf,
    level: label,
    label: `${tf}(${label})`,
    price: levels[key],
  }));
}
