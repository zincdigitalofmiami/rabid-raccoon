/**
 * Correlation Filter — Alignment Scoring
 *
 * Wraps the existing computeCorrelations() from market-context.ts
 * and adds directional alignment scoring for live trigger candidates.
 */

import { CandleData } from "./types";
import { computeCorrelations } from "./market-context";
import type { TriggerDirection } from "./trigger-candidates";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CorrelationAlignment {
  vix: number; // legacy dashboard surface
  dxy: number; // legacy dashboard surface
  nq: number; // raw MES-NQ correlation
  rty?: number;
  cl?: number;
  zn?: number;
  euro?: number; // raw MES-6E correlation
  gc?: number;
  composite: number; // -1 (short-aligned) to +1 (long-aligned)
  isAligned: boolean; // composite agrees with setup direction
  details: string; // human-readable summary
  activeSymbols?: string[];
  alignedSymbols?: string[];
  divergingSymbols?: string[];
  ignoredSymbols?: string[];
}

// ─── Core ─────────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

type CoreSymbolSpec = {
  code: "NQ" | "RTY" | "ZN" | "CL" | "6E";
  field: "nq" | "rty" | "zn" | "cl" | "euro";
  weight: number;
  bullishScore: (raw: number) => number;
  describe(raw: number): string;
};

const CORE_SYMBOL_SPECS: readonly CoreSymbolSpec[] = [
  {
    code: "NQ",
    field: "nq",
    weight: 0.28,
    bullishScore: (raw) => raw,
    describe: (raw) =>
      `NQ ${raw >= 0 ? "confirming" : "diverging"} (${raw.toFixed(2)})`,
  },
  {
    code: "RTY",
    field: "rty",
    weight: 0.24,
    bullishScore: (raw) => raw,
    describe: (raw) =>
      `RTY ${raw >= 0 ? "confirming" : "diverging"} (${raw.toFixed(2)})`,
  },
  {
    code: "ZN",
    field: "zn",
    weight: 0.22,
    bullishScore: (raw) => -raw,
    describe: (raw) =>
      `ZN ${raw <= 0 ? "risk-on inverse" : "defensive bid"} (${raw.toFixed(2)})`,
  },
  {
    code: "CL",
    field: "cl",
    weight: 0.16,
    bullishScore: (raw) => raw,
    describe: (raw) =>
      `CL ${raw >= 0 ? "growth-aligned" : "inflation-headwind"} (${raw.toFixed(2)})`,
  },
  {
    code: "6E",
    field: "euro",
    weight: 0.10,
    bullishScore: (raw) => raw,
    describe: (raw) =>
      `6E ${raw >= 0 ? "USD tailwind" : "USD headwind"} (${raw.toFixed(2)})`,
  },
];

const ALIGNMENT_THRESHOLD = 0.12;

/**
 * Compute alignment score for a given setup direction.
 *
 * Uses the existing pearson correlation computation from market-context.ts,
 * then translates raw correlations into a directional alignment score.
 */
export function computeAlignmentScore(
  symbolCandles: Map<string, CandleData[]>,
  setupDirection: TriggerDirection,
): CorrelationAlignment {
  const correlations = computeCorrelations(symbolCandles);
  const correlationByPair = new Map(correlations.map((item) => [item.pair, item.value]));
  const rawByField: Partial<Record<CoreSymbolSpec["field"], number>> = {};
  const activeSymbols: string[] = [];
  const alignedSymbols: string[] = [];
  const divergingSymbols: string[] = [];
  const ignoredSymbols: string[] = [];
  const parts: string[] = [];

  let weightedScoreSum = 0;
  let availableWeightSum = 0;

  for (const spec of CORE_SYMBOL_SPECS) {
    const raw = correlationByPair.get(`MES↔${spec.code}`);
    if (raw == null) continue;

    rawByField[spec.field] = raw;
    activeSymbols.push(spec.code);

    const bullishScore = spec.bullishScore(raw);
    weightedScoreSum += bullishScore * spec.weight;
    availableWeightSum += spec.weight;

    const directionalScore =
      setupDirection === "BULLISH" ? bullishScore : -bullishScore;

    if (directionalScore >= ALIGNMENT_THRESHOLD) alignedSymbols.push(spec.code);
    else if (directionalScore <= -ALIGNMENT_THRESHOLD) divergingSymbols.push(spec.code);
    else ignoredSymbols.push(spec.code);

    if (Math.abs(raw) >= 0.2) {
      parts.push(spec.describe(raw));
    }
  }

  const composite =
    availableWeightSum > 0
      ? clamp(weightedScoreSum / availableWeightSum, -1, 1)
      : 0;

  // Alignment with the specific setup direction
  const isAligned =
    setupDirection === "BULLISH" ? composite > 0 : composite < 0;

  // Human-readable summary
  const details =
    parts.length > 0
      ? `${isAligned ? "Aligned" : "Conflicted"}: ${parts.join(", ")}`
      : `Neutral trigger basket regime (composite ${composite.toFixed(2)})`;

  return {
    vix: 0,
    dxy: 0,
    nq: rawByField.nq ?? 0,
    rty: rawByField.rty,
    zn: rawByField.zn,
    cl: rawByField.cl,
    euro: rawByField.euro,
    composite: Number(composite.toFixed(3)),
    isAligned,
    details,
    activeSymbols,
    alignedSymbols,
    divergingSymbols,
    ignoredSymbols,
  };
}
