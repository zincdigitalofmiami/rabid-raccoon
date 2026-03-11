/**
 * ml-baseline.ts — ML Baseline Inference via Regime Lookup Table
 *
 * Until a real-time ML model (ONNX or Python sidecar) is available,
 * this module provides historical p(TP1)/p(TP2) baselines by matching
 * a TradeFeatureVector to the nearest regime bucket.
 *
 * The lookup table is built by scripts/build-regime-lookup.ts from
 * actual BHG setup outcomes in bhg_setups.csv.
 *
 * Baseline source: exact historical regime bucket only.
 */

import regimeLookup from '@/data/regime-lookup.json'
import type { TradeFeatureVector } from '@/lib/trade-features'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface MlBaseline {
  pTp1: number            // 0-1 probability of TP1 hit (4h horizon)
  pTp2: number            // 0-1 probability of TP2 hit (8h horizon)
  sampleCount: number     // how many historical setups in this bucket
  confidence: 'high' | 'medium' | 'low'
  source: 'exact'
}

interface BucketEntry {
  key: string
  fibRatio: string
  riskGrade: string
  vixBucket: string
  sessionBucket: string
  goType: string
  count: number
  pTp1_1h: number
  pTp1_4h: number
  pTp2_8h: number
}

interface LookupData {
  buckets: BucketEntry[]
}

// ─────────────────────────────────────────────
// Index for fast lookup
// ─────────────────────────────────────────────

const lookup = regimeLookup as unknown as LookupData
const bucketIndex = new Map<string, BucketEntry>()

for (const b of lookup.buckets) {
  bucketIndex.set(b.key, b)
}

// ─────────────────────────────────────────────
// Feature → bucket key mapping
// ─────────────────────────────────────────────

function featureVixBucket(vixLevel: number | null): string {
  if (vixLevel == null) return 'unknown'
  if (vixLevel < 16) return 'low'
  if (vixLevel <= 25) return 'mid'
  return 'high'
}

function featureFibBucket(fibRatio: number): string {
  return fibRatio <= 0.55 ? '0.5' : '0.618'
}

/**
 * Map the current time to the session bucket used in training data.
 * Mirrors build-bhg-dataset.ts getSessionBucket() exactly.
 * Uses CT (Central Time) hhmm format.
 */
function currentSessionBucket(): string {
  const now = new Date()
  const ctOffset = isDST(now) ? -5 : -6
  const utcHours = now.getUTCHours()
  const utcMinutes = now.getUTCMinutes()
  const ctMinutesTotal = (utcHours * 60 + utcMinutes) + ctOffset * 60
  const ctAdjusted = ((ctMinutesTotal % 1440) + 1440) % 1440
  const hhmm = Math.floor(ctAdjusted / 60) * 100 + (ctAdjusted % 60)

  if (hhmm >= 1700 || hhmm < 830) return 'OVERNIGHT'
  if (hhmm < 1000) return 'RTH_OPEN'
  if (hhmm < 1200) return 'MIDDAY'
  if (hhmm < 1400) return 'LUNCH'
  return 'POWER_HOUR'
}

/** US DST check (second Sunday March – first Sunday November). */
function isDST(date: Date): boolean {
  const year = date.getUTCFullYear()
  const marchSecondSunday = new Date(Date.UTC(year, 2, 8))
  marchSecondSunday.setUTCDate(8 + ((7 - marchSecondSunday.getUTCDay()) % 7))
  const novFirstSunday = new Date(Date.UTC(year, 10, 1))
  novFirstSunday.setUTCDate(1 + ((7 - novFirstSunday.getUTCDay()) % 7))
  // DST switches at 2:00 AM ET = 7:00 UTC (EST) or 6:00 UTC (EDT)
  const dstStart = new Date(marchSecondSunday.getTime() + 7 * 3600_000)
  const dstEnd = new Date(novFirstSunday.getTime() + 6 * 3600_000)
  return date.getTime() >= dstStart.getTime() && date.getTime() < dstEnd.getTime()
}

function buildKey(
  fibRatio: string,
  grade: string,
  vix: string,
  session: string,
  goType: string,
): string {
  return `${fibRatio}|${grade}|${vix}|${session}|${goType}`
}

// ─────────────────────────────────────────────
// Main lookup function
// ─────────────────────────────────────────────

/**
 * Get the ML baseline p(TP1)/p(TP2) for a trade feature vector.
 *
 * Exact-bucket only:
 *   - Must find a matching 5-feature regime key
 *   - Must have at least 5 historical samples
 *
 * Confidence is based on sample count:
 *   - high: ≥30 samples
 *   - medium: ≥10 samples
 *   - low: <10 samples
 */
export function getMlBaseline(features: TradeFeatureVector): MlBaseline {
  const fibR = featureFibBucket(features.fibRatio)
  const vixB = featureVixBucket(features.vixLevel)
  const session = currentSessionBucket()
  const goType = features.goType

  // Try exact match
  const key = buildKey(fibR, features.riskGrade, vixB, session, goType)
  const exact = bucketIndex.get(key)

  if (!exact || exact.count < 5) {
    throw new Error(
      `No exact ML baseline bucket for key=${key}; exact-match baseline is required.`,
    )
  }

  return {
    pTp1: exact.pTp1_4h,
    pTp2: exact.pTp2_8h,
    sampleCount: exact.count,
    confidence: exact.count >= 30 ? 'high' : exact.count >= 10 ? 'medium' : 'low',
    source: 'exact',
  }
}

/**
 * Get baseline for display — includes human-readable context.
 */
export function getBaselineWithContext(features: TradeFeatureVector): MlBaseline & { context: string } {
  const baseline = getMlBaseline(features)

  const context = `Based on ${baseline.sampleCount} exact regime matches (${features.riskGrade}-grade, ${features.goType}, ${featureVixBucket(features.vixLevel)} VIX)`

  return { ...baseline, context }
}
