/**
 * build-lean-dataset.ts
 *
 * THE RABID RACCOON — Lean MES Intraday Dataset Builder
 *
 * ~66 columns, optimized for high-frequency MES day trading.
 * Every feature either moves intraday or defines the trading regime.
 *
 * Design principles:
 *   - Price action first (22 MES technicals)
 *   - Daily macro context that sets the day's tone (19 FRED series)
 *   - Velocity/regime features (6 derived — VIX percentile, yield velocity, dollar momentum)
 *   - Event flags from econ_calendar (FOMC day, high-impact day)
 *   - NO monthly/quarterly stale data (GDP, CPI, NFP, trade balance, etc.)
 *   - NO redundant series (no VVIX when we have VIX, no Brent when we have WTI)
 *
 * Supports both 1h and 15m timeframes via --timeframe flag.
 *
 * Usage:
 *   npx tsx scripts/build-lean-dataset.ts
 *   npx tsx scripts/build-lean-dataset.ts --timeframe=15m
 *   npx tsx scripts/build-lean-dataset.ts --start-date=2022-01-01
 *   npx tsx scripts/build-lean-dataset.ts --days-back=365
 *   npx tsx scripts/build-lean-dataset.ts --out=datasets/autogluon/mes_lean_1h.csv
 */

import { prisma } from '../src/lib/prisma'
import { toNum } from '../src/lib/decimal'
import { loadDotEnvFiles, parseArg } from './ingest-utils'
import {
  asofLookupByDateKey,
  conservativeLagDaysForFrequency,
  dateKeyUtc,
} from './feature-availability'
import {
  buildFredArray,
  rollingPercentile,
  deltaBack,
  pctDeltaBack,
  alignCrossAssetBars,
} from './feature-utils'
import fs from 'node:fs'
import path from 'node:path'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const EVENT_LOOKBACK_WINDOW_DAYS = 365 * 3
const EVENT_LOOKBACK_MIN_OBS = 6
const EVENT_FEATURE_LAG_DAYS = 1
const BHG_RESOLUTION_LAG_MS = 24 * 60 * 60 * 1000

interface EventSignalConfig {
  column: string
  names: string[]
  weight: number
}

const EVENT_SIGNAL_CONFIGS: EventSignalConfig[] = [
  { column: 'nfp_release_z', names: ['NFP'], weight: 3 },
  { column: 'cpi_release_z', names: ['CPI'], weight: 3 },
  { column: 'retail_sales_release_z', names: ['Retail Sales'], weight: 2 },
  { column: 'ppi_release_z', names: ['PPI'], weight: 2 },
  { column: 'gdp_release_z', names: ['GDP'], weight: 2 },
  { column: 'claims_release_z', names: ['Jobless Claims'], weight: 1 },
]

// ─── LEAN FRED SERIES — Only what moves intraday or sets daily tone ──────

interface FredSeriesConfig {
  seriesId: string
  column: string
  table: string
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly'
}

const FRED_FEATURES: FredSeriesConfig[] = [
  // Volatility — the #1 intraday signal
  { seriesId: 'VIXCLS',       column: 'fred_vix',              table: 'econ_vol_indices_1d', frequency: 'daily' },

  // Rates — where the Fed is
  { seriesId: 'DFF',           column: 'fred_dff',              table: 'econ_rates_1d',       frequency: 'daily' },
  { seriesId: 'SOFR',          column: 'fred_sofr',             table: 'econ_rates_1d',       frequency: 'daily' },
  { seriesId: 'DFEDTARL',      column: 'fred_fed_target_lower', table: 'econ_rates_1d',       frequency: 'daily' },
  { seriesId: 'DFEDTARU',      column: 'fred_fed_target_upper', table: 'econ_rates_1d',       frequency: 'daily' },

  // Yield curve — shape defines regime
  { seriesId: 'DGS2',          column: 'fred_y2y',              table: 'econ_yields_1d',      frequency: 'daily' },
  { seriesId: 'DGS10',         column: 'fred_y10y',             table: 'econ_yields_1d',      frequency: 'daily' },
  { seriesId: 'DGS30',         column: 'fred_y30y',             table: 'econ_yields_1d',      frequency: 'daily' },

  // FX — dollar strength drives everything
  { seriesId: 'DTWEXBGS',      column: 'fred_dxy',              table: 'econ_fx_1d',          frequency: 'daily' },
  { seriesId: 'DEXUSEU',       column: 'fred_eurusd',           table: 'econ_fx_1d',          frequency: 'daily' },
  { seriesId: 'DEXJPUS',       column: 'fred_jpyusd',           table: 'econ_fx_1d',          frequency: 'daily' },

  // Commodities — energy shock proxy
  { seriesId: 'DCOILWTICO',    column: 'fred_wti',              table: 'econ_commodities_1d', frequency: 'daily' },
  { seriesId: 'PCOPPUSDM',     column: 'fred_copper',           table: 'econ_commodities_1d', frequency: 'monthly' },

  // Liquidity — Fed balance sheet dynamics
  { seriesId: 'WALCL',         column: 'fred_fed_assets',       table: 'econ_money_1d',       frequency: 'weekly' },
  { seriesId: 'RRPONTSYD',     column: 'fred_rrp',              table: 'econ_money_1d',       frequency: 'daily' },

  // Labor — weekly pulse
  { seriesId: 'ICSA',          column: 'fred_claims',           table: 'econ_labor_1d',       frequency: 'weekly' },

  // Credit — risk appetite
  { seriesId: 'BAMLC0A0CM',    column: 'fred_ig_oas',           table: 'econ_vol_indices_1d', frequency: 'daily' },
  { seriesId: 'BAMLH0A0HYM2',  column: 'fred_hy_oas',           table: 'econ_vol_indices_1d', frequency: 'daily' },

  // Real yields — TIPS 10Y for proper real rate
  { seriesId: 'DFII10',         column: 'fred_tips10y',          table: 'econ_inflation_1d',   frequency: 'daily' },
]

// Feature index helpers
function featureIndex(column: string): number {
  const idx = FRED_FEATURES.findIndex((f) => f.column === column)
  if (idx < 0) throw new Error(`Missing feature column '${column}'`)
  return idx
}

const IDX_VIX = featureIndex('fred_vix')
const IDX_DFF = featureIndex('fred_dff')
const IDX_FED_TARGET_LOWER = featureIndex('fred_fed_target_lower')
const IDX_FED_TARGET_UPPER = featureIndex('fred_fed_target_upper')
const IDX_Y2Y = featureIndex('fred_y2y')
const IDX_Y10Y = featureIndex('fred_y10y')
const IDX_DXY = featureIndex('fred_dxy')
const IDX_IG_OAS = featureIndex('fred_ig_oas')
const IDX_HY_OAS = featureIndex('fred_hy_oas')
const IDX_FED_ASSETS = featureIndex('fred_fed_assets')
const IDX_RRP = featureIndex('fred_rrp')
const IDX_TIPS10Y = featureIndex('fred_tips10y')

const FRED_LAG_BY_COLUMN = new Map(
  FRED_FEATURES.map((f) => [f.column, conservativeLagDaysForFrequency(f.frequency)])
)

// ─── CROSS-ASSET SYMBOLS — regime-aligned intermarket features ────────────
// These are loaded from mkt_futures_1h (hourly, multi-symbol table).
// 6 technicals per symbol × 6 symbols = 36 columns + 5 derived = 41 total.

interface CrossAssetSymbol {
  code: string       // DB symbolCode
  prefix: string     // feature column prefix (safe for CSV headers)
}

const CROSS_ASSET_SYMBOLS: CrossAssetSymbol[] = [
  { code: 'NQ',  prefix: 'nq'  },  // tech beta / duration
  { code: 'ZN',  prefix: 'zn'  },  // 10Y rate impulse
  { code: 'CL',  prefix: 'cl'  },  // energy / AI power narrative
  { code: '6E',  prefix: 'e6'  },  // EUR/USD — USD liquidity (prefix avoids leading digit)
  { code: '6J',  prefix: 'j6'  },  // JPY/USD — carry unwind stress
  { code: 'NG',  prefix: 'ng'  },  // natural gas — AI data center power
]

// ─── TYPES ────────────────────────────────────────────────────────────────

interface MesCandle {
  eventTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: bigint | null
}

type FredLookup = Map<string, number>

interface CalendarEventLite {
  eventDate: Date
  eventName: string
  eventType: string
  impactRating: string | null
  eventTime: string | null
  actual: number | null
}

interface EventSignalRow {
  releaseMs: number
  dateKey: string
  eventName: string
  actual: number
}

// ─── HELPERS ──────────────────────────────────────────────────────────────

function pctChange(current: number, previous: number): number | null {
  if (previous === 0 || !Number.isFinite(previous) || !Number.isFinite(current)) return null
  return (current - previous) / Math.abs(previous)
}

// computeRSI removed — replaced by computeEDSS (Ehlers DSP-based)

const EDSS_PI_LEAN = Math.PI

function edssSuperSmootherLean(price: number[], lower: number): number[] {
  const a1 = Math.exp(-EDSS_PI_LEAN * Math.sqrt(2) / lower)
  const coeff2 = 2 * a1 * Math.cos(Math.sqrt(2) * EDSS_PI_LEAN / lower)
  const coeff3 = -Math.pow(a1, 2)
  const coeff1 = 1 - coeff2 - coeff3
  const out: number[] = new Array(price.length).fill(0)
  for (let i = 0; i < price.length; i++) {
    const p1 = i >= 1 ? price[i - 1] : price[i]
    const f1 = i >= 1 ? out[i - 1] : 0
    const f2 = i >= 2 ? out[i - 2] : 0
    out[i] = coeff1 * (price[i] + p1) / 2 + coeff2 * f1 + coeff3 * f2
  }
  return out
}

function edssRoofingFilterLean(price: number[], upper: number, lower: number): number[] {
  const alpha1 = (Math.cos(Math.sqrt(2) * EDSS_PI_LEAN / upper) + Math.sin(Math.sqrt(2) * EDSS_PI_LEAN / upper) - 1)
                / Math.cos(Math.sqrt(2) * EDSS_PI_LEAN / upper)
  const hp: number[] = new Array(price.length).fill(0)
  for (let i = 0; i < price.length; i++) {
    const p1 = i >= 1 ? price[i - 1] : price[i]
    const p2 = i >= 2 ? price[i - 2] : price[i]
    const h1 = i >= 1 ? hp[i - 1] : 0
    const h2 = i >= 2 ? hp[i - 2] : 0
    hp[i] = Math.pow(1 - alpha1 / 2, 2) * (price[i] - 2 * p1 + p2) + 2 * (1 - alpha1) * h1 - Math.pow(1 - alpha1, 2) * h2
  }
  return edssSuperSmootherLean(hp, lower)
}

function computeEDSSLean(closes: number[], length = 14, roofUpper = 48, roofLower = 10): (number | null)[] {
  const warmup = roofUpper + length
  const filt = edssRoofingFilterLean(closes, roofUpper, roofLower)
  const rawStoch: number[] = new Array(closes.length).fill(0)
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - length + 1)
    const slice = filt.slice(start, i + 1)
    const hi = Math.max(...slice), lo = Math.min(...slice)
    // FIX: near-zero range = no cycle detected → neutral 0.5, not 0
    rawStoch[i] = (hi - lo) > 1e-10 ? (filt[i] - lo) / (hi - lo) : 0.5
  }
  // FIX: clamp to [0,1] — super smoother overshoots ~4%
  const stoch = edssSuperSmootherLean(rawStoch, roofLower).map(v => Math.max(0, Math.min(1, v)))
  // FIX: null-mask warmup bars
  return stoch.map((v, i) => i < warmup ? null : v)
}

function rollingMean(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let sum = 0
    for (let j = i - window + 1; j <= i; j++) sum += values[j]
    result[i] = sum / window
  }
  return result
}

function rollingStd(values: number[], window: number): (number | null)[] {
  const means = rollingMean(values, window)
  const result: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    const mean = means[i]!
    let sumSq = 0
    for (let j = i - window + 1; j <= i; j++) sumSq += (values[j] - mean) ** 2
    result[i] = Math.sqrt(sumSq / window)
  }
  return result
}

// ─── SQUEEZE PRO ──────────────────────────────────────────────────────────
// John Carter's Squeeze Pro: BB vs KC at 3 levels detects volatility compression.
// Momentum oscillator: linreg(close - midline, length, 0) shows expansion direction.
//
// Squeeze states: 0=none, 1=wide(orange), 2=normal(red), 3=narrow(yellow), 4=fired(green)

function computeSMA(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= window) sum -= values[i - window]
    if (i >= window - 1) result[i] = sum / window
  }
  return result
}

function rollingHighest(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let max = -Infinity
    for (let j = i - window + 1; j <= i; j++) { if (values[j] > max) max = values[j] }
    result[i] = max
  }
  return result
}

function rollingLowest(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let min = Infinity
    for (let j = i - window + 1; j <= i; j++) { if (values[j] < min) min = values[j] }
    result[i] = min
  }
  return result
}

function linreg(values: (number | null)[], window: number): (number | null)[] {
  // Linear regression value (offset=0, i.e. endpoint) over rolling window
  const result: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, n = 0
    for (let j = 0; j < window; j++) {
      const v = values[i - window + 1 + j]
      if (v == null) continue
      sumX += j; sumY += v; sumXY += j * v; sumX2 += j * j; n++
    }
    if (n < window * 0.5) continue
    const denom = n * sumX2 - sumX * sumX
    if (Math.abs(denom) < 1e-15) continue
    const slope = (n * sumXY - sumX * sumY) / denom
    const intercept = (sumY - slope * sumX) / n
    result[i] = intercept + slope * (window - 1) // value at endpoint
  }
  return result
}

interface SqueezeProResult {
  mom: (number | null)[]      // momentum oscillator
  state: (number | null)[]    // 0=none, 1=wide, 2=normal, 3=narrow, 4=fired
}

function computeSqueezePro(
  closes: number[], highs: number[], lows: number[], length = 20
): SqueezeProResult {
  const n = closes.length
  const ma = computeSMA(closes, length)

  // True Range
  const tr: number[] = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    const prevClose = i > 0 ? closes[i - 1] : closes[i]
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - prevClose), Math.abs(lows[i] - prevClose))
  }

  // Bollinger Band deviation (population stdev)
  const devBB: (number | null)[] = new Array(n).fill(null)
  for (let i = length - 1; i < n; i++) {
    const m = ma[i]!
    let sumSq = 0
    for (let j = i - length + 1; j <= i; j++) sumSq += (closes[j] - m) ** 2
    devBB[i] = Math.sqrt(sumSq / length)
  }

  // Keltner deviation = SMA(TR, length)
  const devKC = computeSMA(tr, length)

  // Squeeze state
  const state: (number | null)[] = new Array(n).fill(null)
  for (let i = length - 1; i < n; i++) {
    const m = ma[i]; const bb = devBB[i]; const kc = devKC[i]
    if (m == null || bb == null || kc == null) continue

    const upBB = m + bb * 2, lowBB = m - bb * 2
    const upKCWide = m + kc * 2, lowKCWide = m - kc * 2
    const upKCNorm = m + kc * 1.5, lowKCNorm = m - kc * 1.5
    const upKCNarrow = m + kc, lowKCNarrow = m - kc

    const sqzNarrow = lowBB >= lowKCNarrow && upBB <= upKCNarrow
    const sqzNormal = lowBB >= lowKCNorm && upBB <= upKCNorm
    const sqzWide = lowBB >= lowKCWide && upBB <= upKCWide
    const fired = lowBB < lowKCWide && upBB > upKCWide

    if (sqzNarrow) state[i] = 3        // max compression (yellow)
    else if (sqzNormal) state[i] = 2   // normal compression (red)
    else if (sqzWide) state[i] = 1     // light compression (orange)
    else if (fired) state[i] = 4       // fired / expansion (green)
    else state[i] = 0                  // no squeeze (blue)
  }

  // Momentum: linreg(close - avg(avg(highest(high,L), lowest(low,L)), sma(close,L)), L, 0)
  const hh = rollingHighest(highs, length)
  const ll = rollingLowest(lows, length)
  const midline: (number | null)[] = new Array(n).fill(null)
  for (let i = length - 1; i < n; i++) {
    const h = hh[i]; const l = ll[i]; const m = ma[i]
    if (h != null && l != null && m != null) {
      midline[i] = ((h + l) / 2 + m) / 2
    }
  }
  const delta: (number | null)[] = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    if (midline[i] != null) delta[i] = closes[i] - midline[i]!
  }
  const mom = linreg(delta, length)

  return { mom, state }
}

// ─── CM WILLIAMS VIX FIX ────────────────────────────────────────────────────
// Synthetic VIX from price structure: ((highest(close,22) - low) / highest(close,22)) * 100
// Fear spike when WVF >= upperBand or WVF >= rangeHigh

interface WvfResult {
  wvf: (number | null)[]         // raw Williams Vix Fix value
  signal: (number | null)[]      // 1 = fear spike (above bands), 0 = normal
  percentile: (number | null)[]  // wvf / rangeHigh — 0-1 scale of fear intensity
}

function computeWilliamsVixFix(
  closes: number[], lows: number[],
  pd = 22, bbl = 20, mult = 2.0, lb = 50, ph = 0.85
): WvfResult {
  const n = closes.length
  const hc = rollingHighest(closes, pd)

  // Raw WVF
  const wvf: (number | null)[] = new Array(n).fill(null)
  for (let i = pd - 1; i < n; i++) {
    if (hc[i] != null && hc[i]! > 0) {
      wvf[i] = ((hc[i]! - lows[i]) / hc[i]!) * 100
    }
  }

  // BB on WVF
  const wvfNums: number[] = wvf.map(v => v ?? 0)
  const wvfMa = computeSMA(wvfNums, bbl)
  const wvfStd: (number | null)[] = new Array(n).fill(null)
  for (let i = bbl - 1; i < n; i++) {
    if (wvfMa[i] == null) continue
    let sumSq = 0
    for (let j = i - bbl + 1; j <= i; j++) sumSq += (wvfNums[j] - wvfMa[i]!) ** 2
    wvfStd[i] = Math.sqrt(sumSq / bbl)
  }

  // Range percentile
  const wvfHighest = rollingHighest(wvfNums, lb)

  const signal: (number | null)[] = new Array(n).fill(null)
  const percentile: (number | null)[] = new Array(n).fill(null)

  for (let i = Math.max(pd, bbl, lb) - 1; i < n; i++) {
    if (wvf[i] == null) continue
    const upperBand = wvfMa[i] != null && wvfStd[i] != null ? wvfMa[i]! + mult * wvfStd[i]! : null
    const rangeHigh = wvfHighest[i] != null ? wvfHighest[i]! * ph : null

    const isSignal = (upperBand != null && wvf[i]! >= upperBand) ||
                     (rangeHigh != null && wvf[i]! >= rangeHigh)
    signal[i] = isSignal ? 1 : 0

    if (rangeHigh != null && rangeHigh > 0) {
      percentile[i] = Math.min(wvf[i]! / rangeHigh, 2.0) // cap at 2x
    }
  }

  return { wvf, signal, percentile }
}

// ─── CM ULTIMATE MACD (vectorized) ──────────────────────────────────────────
// Port of ChrisMoody CM_MacD_Ult_MTF — vectorized for full array
// fast=12, slow=26, signal=9 (SMA of MACD line)
// Histogram 4-color: 0=aqua(rise+pos), 1=blue(fall+pos), 2=red(fall+neg), 3=maroon(rise+neg)

interface CmMacdArrayResult {
  line: (number | null)[]
  signal: (number | null)[]
  hist: (number | null)[]
  histColor: (number | null)[]
  aboveSignal: (number | null)[]
  histRising: (number | null)[]
}

function computeCmMacdVectorized(
  closes: number[],
  fastLength = 12,
  slowLength = 26,
  signalLength = 9,
): CmMacdArrayResult {
  const n = closes.length
  const warmup = slowLength + signalLength - 1
  const line: (number | null)[] = new Array(n).fill(null)
  const sig: (number | null)[] = new Array(n).fill(null)
  const hist: (number | null)[] = new Array(n).fill(null)
  const histColor: (number | null)[] = new Array(n).fill(null)
  const aboveSignal: (number | null)[] = new Array(n).fill(null)
  const histRising: (number | null)[] = new Array(n).fill(null)

  // EMA arrays
  const fastEma: number[] = new Array(n).fill(0)
  const slowEma: number[] = new Array(n).fill(0)
  const fastMult = 2 / (fastLength + 1)
  const slowMult = 2 / (slowLength + 1)

  fastEma[0] = closes[0]
  slowEma[0] = closes[0]
  for (let i = 1; i < n; i++) {
    fastEma[i] = (closes[i] - fastEma[i - 1]) * fastMult + fastEma[i - 1]
    slowEma[i] = (closes[i] - slowEma[i - 1]) * slowMult + slowEma[i - 1]
  }

  // MACD line = fast - slow
  const macdLine: number[] = new Array(n).fill(0)
  for (let i = 0; i < n; i++) macdLine[i] = fastEma[i] - slowEma[i]

  // Signal = SMA of MACD line
  const signalArr: number[] = new Array(n).fill(0)
  let sigSum = 0
  for (let i = 0; i < n; i++) {
    sigSum += macdLine[i]
    if (i >= signalLength) sigSum -= macdLine[i - signalLength]
    if (i >= signalLength - 1) signalArr[i] = sigSum / signalLength
  }

  // Populate output arrays
  for (let i = warmup; i < n; i++) {
    const l = macdLine[i]
    const s = signalArr[i]
    const h = l - s
    const hPrev = i > warmup ? macdLine[i - 1] - signalArr[i - 1] : h

    line[i] = l
    sig[i] = s
    hist[i] = h
    aboveSignal[i] = l >= s ? 1 : 0
    histRising[i] = h > hPrev ? 1 : 0

    const rising = h > hPrev
    if (h > 0) histColor[i] = rising ? 0 : 1      // aqua : blue
    else histColor[i] = !rising ? 2 : 3            // red : maroon
  }

  return { line, signal: sig, hist, histColor, aboveSignal, histRising }
}

// ─── ROLLING PEARSON CORRELATION (vectorized) ───────────────────────────────

function rollingPearsonCorr(
  xs: (number | null)[],
  ys: (number | null)[],
  window: number,
  minPairs = 10,
): (number | null)[] {
  const n = xs.length
  const result: (number | null)[] = new Array(n).fill(null)
  for (let i = window - 1; i < n; i++) {
    const xVals: number[] = []
    const yVals: number[] = []
    for (let j = i - window + 1; j <= i; j++) {
      if (xs[j] != null && ys[j] != null) { xVals.push(xs[j]!); yVals.push(ys[j]!) }
    }
    if (xVals.length < minPairs) continue
    const meanX = xVals.reduce((a, b) => a + b, 0) / xVals.length
    const meanY = yVals.reduce((a, b) => a + b, 0) / yVals.length
    let cov = 0, varX = 0, varY = 0
    for (let k = 0; k < xVals.length; k++) {
      cov += (xVals[k] - meanX) * (yVals[k] - meanY)
      varX += (xVals[k] - meanX) ** 2
      varY += (yVals[k] - meanY) ** 2
    }
    const denom = Math.sqrt(varX * varY)
    result[i] = denom > 0 ? cov / denom : null
  }
  return result
}

function rollingMinMax(values: number[], window: number): { min: (number | null)[]; max: (number | null)[] } {
  const mins: (number | null)[] = new Array(values.length).fill(null)
  const maxs: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let lo = Infinity, hi = -Infinity
    for (let j = i - window + 1; j <= i; j++) {
      if (values[j] < lo) lo = values[j]
      if (values[j] > hi) hi = values[j]
    }
    mins[i] = lo; maxs[i] = hi
  }
  return { min: mins, max: maxs }
}

function parseEventDateTimeMs(eventDate: Date, eventTime: string | null): number {
  const base = new Date(Date.UTC(
    eventDate.getUTCFullYear(),
    eventDate.getUTCMonth(),
    eventDate.getUTCDate(),
    0, 0, 0, 0
  ))
  if (!eventTime) return base.getTime()

  const match = eventTime.match(/(\d{1,2}):(\d{2})/)
  if (!match) return base.getTime()
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return base.getTime()
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return base.getTime()

  base.setUTCHours(hours, minutes, 0, 0)
  return base.getTime()
}

function stdDev(values: number[]): number | null {
  if (values.length < 2) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function buildReleaseChangeZLookup(
  rows: EventSignalRow[],
  names: string[],
  windowDays: number,
  minObs: number
): { lookup: FredLookup; sortedKeys: string[]; computed: number } {
  const nameSet = new Set(names.map((name) => name.toUpperCase()))
  const filtered = rows
    .filter((row) => nameSet.has(row.eventName.toUpperCase()))
    .sort((a, b) => a.releaseMs - b.releaseMs)

  let prevActual: number | null = null
  const deltas: Array<{ releaseMs: number; delta: number }> = []
  const lookup: FredLookup = new Map()
  let computed = 0

  for (const row of filtered) {
    if (prevActual != null) {
      const delta = row.actual - prevActual
      const cutoff = row.releaseMs - windowDays * MS_PER_DAY
      const windowDeltas = deltas
        .filter((point) => point.releaseMs >= cutoff)
        .map((point) => point.delta)

      if (windowDeltas.length >= minObs) {
        const sigma = stdDev(windowDeltas)
        if (sigma != null && sigma > 0) {
          lookup.set(row.dateKey, delta / sigma)
          computed += 1
        }
      }
      deltas.push({ releaseMs: row.releaseMs, delta })
    }

    prevActual = row.actual
  }

  return {
    lookup,
    sortedKeys: [...lookup.keys()].sort(),
    computed,
  }
}

function weightedAverage(values: Array<number | null>, weights: number[]): number | null {
  let weightedSum = 0
  let weightTotal = 0
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (value == null) continue
    const weight = weights[i]
    weightedSum += value * weight
    weightTotal += weight
  }
  if (weightTotal === 0) return null
  return weightedSum / weightTotal
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function trailingCountLagged(
  ts: Date,
  countsByDate: ReadonlyMap<string, number>,
  trailingDays: number,
  lagDays: number
): number {
  const endMs = ts.getTime() - lagDays * MS_PER_DAY
  const startMs = endMs - (trailingDays - 1) * MS_PER_DAY
  let total = 0
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    total += countsByDate.get(dateKeyUtc(new Date(ms))) ?? 0
  }
  return total
}

function centeredCount(
  ts: Date,
  countsByDate: ReadonlyMap<string, number>,
  daysBack: number,
  daysForward: number
): number {
  const centerDayMs = new Date(Date.UTC(
    ts.getUTCFullYear(),
    ts.getUTCMonth(),
    ts.getUTCDate(),
    0, 0, 0, 0
  )).getTime()
  const startMs = centerDayMs - daysBack * MS_PER_DAY
  const endMs = centerDayMs + daysForward * MS_PER_DAY
  let total = 0
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    total += countsByDate.get(dateKeyUtc(new Date(ms))) ?? 0
  }
  return total
}

function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(sorted: readonly number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function countInTimeRange(sortedTimes: readonly number[], startInclusive: number, endInclusive: number): number {
  if (sortedTimes.length === 0 || endInclusive < startInclusive) return 0
  const startIdx = lowerBound(sortedTimes, startInclusive)
  const endIdx = upperBound(sortedTimes, endInclusive)
  return Math.max(0, endIdx - startIdx)
}

// ─── MAIN ─────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  loadDotEnvFiles()

  const timeframe = parseArg('timeframe', '1h') as '1h' | '15m'
  const startDateArg = parseArg('start-date', '2020-01-01')
  const daysBackArg = parseArg('days-back', '')
  const defaultOut = timeframe === '15m'
    ? 'datasets/autogluon/mes_lean_15m.csv'
    : 'datasets/autogluon/mes_lean_1h.csv'
  const outFile = parseArg('out', defaultOut)
  // --days-back overrides --start-date if provided; otherwise default to 2020-01-01
  const start = daysBackArg
    ? new Date(Date.now() - Number(daysBackArg) * 24 * 60 * 60 * 1000)
    : new Date(startDateArg + 'T00:00:00Z')
  const calendarLoadStart = new Date(start.getTime() - (EVENT_LOOKBACK_WINDOW_DAYS + 60) * MS_PER_DAY)

  const barsPerDay = timeframe === '15m' ? 96 : 24
  const velocityLookback = 5 * barsPerDay  // 5 trading days

  const daysBack = Math.ceil((Date.now() - start.getTime()) / (24 * 60 * 60 * 1000))
  console.log(`[lean-dataset] Building LEAN MES ${timeframe} dataset for intraday trading`)
  console.log(`[lean-dataset] Timeframe: ${timeframe}, Start: ${start.toISOString().slice(0,10)}, Days back: ${daysBack}`)
  console.log(`[lean-dataset] Bars/day: ${barsPerDay}, Velocity lookback: ${velocityLookback} bars`)

  // ── 1. Load MES candles (paginated to stay under Prisma Accelerate 5MB limit) ──
  const tableName = timeframe === '15m' ? 'mktFuturesMes15m' : 'mktFuturesMes1h'
  const candles: MesCandle[] = []
  const CHUNK_MS = 365 * 24 * 60 * 60 * 1000 // 1 year per chunk
  let chunkStart = start
  const now = new Date()
  while (chunkStart < now) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + CHUNK_MS, now.getTime()))
    const rawChunk = await (prisma as any)[tableName].findMany({
      where: { eventTime: { gte: chunkStart, lt: chunkEnd } },
      orderBy: { eventTime: 'asc' },
      select: { eventTime: true, open: true, high: true, low: true, close: true, volume: true },
    })
    for (const r of rawChunk) {
      candles.push({
        eventTime: r.eventTime,
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close: toNum(r.close),
        volume: r.volume,
      })
    }
    chunkStart = chunkEnd
  }

  if (candles.length < 200) {
    throw new Error(`Insufficient MES ${timeframe} data (${candles.length} rows, need 200+)`)
  }
  console.log(`[lean-dataset] MES ${timeframe} candles: ${candles.length}`)

  // ── 1b. Load cross-asset hourly candles from mkt_futures_1h ──
  // Only meaningful for 1h timeframe; for 15m we still align on the hourly bars.
  console.log(`[lean-dataset] Loading cross-asset hourly candles (${CROSS_ASSET_SYMBOLS.map(s => s.code).join(', ')})...`)

  interface CrossAssetBar { eventTime: Date; close: number; volume: bigint | null }

  // Map: symbolCode → Map<isoString → bar>
  const crossAssetBars = new Map<string, Map<string, CrossAssetBar>>()

  const crossAssetStart = new Date(start.getTime() - 200 * 60 * 60 * 1000) // extra 200h for warmup
  for (const sym of CROSS_ASSET_SYMBOLS) {
    const barMap = new Map<string, CrossAssetBar>()
    let caChunkStart = crossAssetStart
    while (caChunkStart < now) {
      const caChunkEnd = new Date(Math.min(caChunkStart.getTime() + CHUNK_MS, now.getTime()))
      const rows = await prisma.mktFutures1h.findMany({
        where: {
          symbolCode: sym.code,
          eventTime: { gte: caChunkStart, lt: caChunkEnd },
        },
        orderBy: { eventTime: 'asc' },
        select: { eventTime: true, close: true, volume: true },
      })
      for (const r of rows) {
        barMap.set(r.eventTime.toISOString(), {
          eventTime: r.eventTime,
          close: toNum(r.close),
          volume: r.volume,
        })
      }
      caChunkStart = caChunkEnd
    }
    crossAssetBars.set(sym.code, barMap)
    console.log(`  ${sym.code.padEnd(4)} ${barMap.size} hourly bars`)
  }

  // Align each symbol's close prices to MES timestamps
  const crossAssetAligned = new Map<string, (number | null)[]>()
  for (const sym of CROSS_ASSET_SYMBOLS) {
    const barMap = crossAssetBars.get(sym.code)!
    const closeMap = new Map<string, number>()
    for (const [key, bar] of barMap) closeMap.set(key, bar.close)
    crossAssetAligned.set(sym.code, alignCrossAssetBars(candles.map(c => c.eventTime), closeMap))
  }

  // Align volumes — NO forward-fill (stale volume is misleading)
  const crossAssetVolAligned = new Map<string, (number | null)[]>()
  for (const sym of CROSS_ASSET_SYMBOLS) {
    const barMap = crossAssetBars.get(sym.code)!
    const volResult: (number | null)[] = new Array(candles.length).fill(null)
    for (let j = 0; j < candles.length; j++) {
      const key = candles[j].eventTime.toISOString()
      const bar = barMap.get(key)
      if (bar && bar.volume != null) volResult[j] = Number(bar.volume)
    }
    crossAssetVolAligned.set(sym.code, volResult)
  }

  console.log(`[lean-dataset] Cross-asset bars aligned to MES timeline`)

  // ── 2. Load FRED series ──
  console.log(`[lean-dataset] Loading ${FRED_FEATURES.length} FRED series (lean set)...`)

  const fredLookups: Map<string, { lookup: FredLookup; sortedKeys: string[] }> = new Map()
  const tableSeriesMap = new Map<string, FredSeriesConfig[]>()
  for (const f of FRED_FEATURES) {
    const list = tableSeriesMap.get(f.table) || []
    list.push(f)
    tableSeriesMap.set(f.table, list)
  }

  for (const [table, configs] of tableSeriesMap) {
    const seriesIds = configs.map((c) => c.seriesId)
    const rows = await prisma.$queryRawUnsafe<{ seriesId: string; eventDate: Date; value: number }[]>(
      `SELECT "seriesId", "eventDate"::date as "eventDate", value FROM "${table}" WHERE "seriesId" = ANY($1) AND value IS NOT NULL ORDER BY "eventDate" ASC`,
      seriesIds
    )
    const grouped = new Map<string, Array<{ date: string; value: number }>>()
    for (const row of rows) {
      const list = grouped.get(row.seriesId) || []
      list.push({ date: dateKeyUtc(row.eventDate), value: Number(row.value) })
      grouped.set(row.seriesId, list)
    }
    for (const config of configs) {
      const data = grouped.get(config.seriesId) || []
      const lookup: FredLookup = new Map()
      const keys: string[] = []
      for (const d of data) { lookup.set(d.date, d.value); keys.push(d.date) }
      fredLookups.set(config.column, { lookup, sortedKeys: keys })
      console.log(`  ${config.column} (${config.seriesId}): ${data.length} points`)
    }
  }

  // ── 3. Load econ_calendar for event, regime, and release-signal features ──
  console.log('[lean-dataset] Loading economic calendar for event and release-signal features...')
  const calendarEventsRaw = await prisma.econCalendar.findMany({
    where: { eventDate: { gte: calendarLoadStart } },
    select: {
      eventDate: true,
      eventName: true,
      eventType: true,
      impactRating: true,
      eventTime: true,
      actual: true,
    },
    orderBy: { eventDate: 'asc' },
  })

  const calendarEvents: CalendarEventLite[] = calendarEventsRaw.map((evt) => ({
    eventDate: evt.eventDate,
    eventName: evt.eventName,
    eventType: evt.eventType,
    impactRating: evt.impactRating,
    eventTime: evt.eventTime,
    actual: evt.actual == null ? null : toNum(evt.actual),
  }))

  const calendarLookup = new Map<string, CalendarEventLite[]>()
  const calendarCountsByDate = new Map<string, number>()
  const highImpactReleaseTimesMs: number[] = []
  const eventSignalRows: EventSignalRow[] = []

  for (const evt of calendarEvents) {
    const dateKey = dateKeyUtc(evt.eventDate)
    const list = calendarLookup.get(dateKey) || []
    list.push(evt)
    calendarLookup.set(dateKey, list)
    incrementCount(calendarCountsByDate, dateKey)

    const releaseMs = parseEventDateTimeMs(evt.eventDate, evt.eventTime)
    if (evt.impactRating?.toLowerCase() === 'high') {
      highImpactReleaseTimesMs.push(releaseMs)
    }
    if (evt.actual != null && Number.isFinite(evt.actual)) {
      eventSignalRows.push({
        releaseMs,
        dateKey,
        eventName: evt.eventName,
        actual: evt.actual,
      })
    }
  }
  highImpactReleaseTimesMs.sort((a, b) => a - b)

  const eventSignalLookups = new Map<string, { lookup: FredLookup; sortedKeys: string[] }>()
  for (const config of EVENT_SIGNAL_CONFIGS) {
    const built = buildReleaseChangeZLookup(
      eventSignalRows,
      config.names,
      EVENT_LOOKBACK_WINDOW_DAYS,
      EVENT_LOOKBACK_MIN_OBS
    )
    eventSignalLookups.set(config.column, { lookup: built.lookup, sortedKeys: built.sortedKeys })
    console.log(`  ${config.column.padEnd(24)} ${String(built.computed).padStart(4)} z-points`)
  }
  console.log(`  Calendar events: ${calendarEvents.length} rows, ${calendarLookup.size} unique dates`)

  // ── 4. Load news from historical tables for 7d rolling features ──
  // Uses econ_calendar (2020+), econ_news_1d (2020+), policy_news_1d (2024+)
  // instead of news_signals (which only has last few days from Google News RSS)
  console.log('[lean-dataset] Loading econ_calendar + econ_news_1d + policy_news_1d for trailing counts...')

  const newsLookbackMs = 45 * MS_PER_DAY
  const newsStartDate = new Date(start.getTime() - newsLookbackMs)

  // econ_calendar: structured events with eventType + impactRating
  const calendarNewsRows = await prisma.econCalendar.findMany({
    where: { eventDate: { gte: newsStartDate } },
    select: { eventDate: true, eventType: true, impactRating: true },
    orderBy: { eventDate: 'asc' },
  })

  // econ_news_1d: economic news articles (FRED blog, BEA, EIA)
  const econNewsRows = await prisma.econNews1d.findMany({
    where: { eventDate: { gte: newsStartDate } },
    select: { eventDate: true },
    orderBy: { eventDate: 'asc' },
  })

  // policy_news_1d: regulatory/policy news (Fed, SEC, ECB, CFTC, White House)
  const policyNewsRows = await prisma.policyNews1d.findMany({
    where: { eventDate: { gte: newsStartDate } },
    select: { eventDate: true },
    orderBy: { eventDate: 'asc' },
  })

  // Build date-count maps from real historical tables
  const calEventsTotalByDate = new Map<string, number>()
  const calEventsHighByDate = new Map<string, number>()
  const calRateEventsByDate = new Map<string, number>()
  const calInflationEventsByDate = new Map<string, number>()
  const calEmploymentEventsByDate = new Map<string, number>()

  for (const row of calendarNewsRows) {
    const dateKey = dateKeyUtc(row.eventDate)
    const eventType = (row.eventType ?? '').toLowerCase()
    const impact = (row.impactRating ?? '').toLowerCase()

    incrementCount(calEventsTotalByDate, dateKey)
    if (impact === 'high') incrementCount(calEventsHighByDate, dateKey)
    if (eventType === 'rates' || eventType === 'rate_decision') incrementCount(calRateEventsByDate, dateKey)
    if (eventType === 'inflation') incrementCount(calInflationEventsByDate, dateKey)
    if (eventType === 'employment') incrementCount(calEmploymentEventsByDate, dateKey)
  }

  const econNewsVolumeByDate = new Map<string, number>()
  for (const row of econNewsRows) {
    incrementCount(econNewsVolumeByDate, dateKeyUtc(row.eventDate))
  }

  const policyNewsVolumeByDate = new Map<string, number>()
  for (const row of policyNewsRows) {
    incrementCount(policyNewsVolumeByDate, dateKeyUtc(row.eventDate))
  }

  // Combined total
  const newsTotalVolumeByDate = new Map<string, number>()
  for (const [k, v] of econNewsVolumeByDate) newsTotalVolumeByDate.set(k, (newsTotalVolumeByDate.get(k) ?? 0) + v)
  for (const [k, v] of policyNewsVolumeByDate) newsTotalVolumeByDate.set(k, (newsTotalVolumeByDate.get(k) ?? 0) + v)

  console.log(`  Calendar events: ${calendarNewsRows.length} rows (${calEventsTotalByDate.size} dates, ${calEventsHighByDate.size} with high-impact)`)
  console.log(`  Econ news:       ${econNewsRows.length} rows (${econNewsVolumeByDate.size} dates)`)
  console.log(`  Policy news:     ${policyNewsRows.length} rows (${policyNewsVolumeByDate.size} dates)`)
  console.log(`  Combined news:   ${newsTotalVolumeByDate.size} unique dates`)

  // ── 5. Load BHG setup timestamps for rolling setup-count features ──
  console.log('[lean-dataset] Loading bhg_setups for rolling setup-count features...')
  const bhgRows = await prisma.bhgSetup.findMany({
    where: { goTime: { gte: new Date(start.getTime() - 400 * MS_PER_DAY) } },
    select: { goTime: true },
    orderBy: { goTime: 'asc' },
  })

  const bhgAllGoTimesMs: number[] = []
  for (const row of bhgRows) {
    if (!row.goTime) continue
    bhgAllGoTimesMs.push(row.goTime.getTime())
  }
  console.log(`  BHG setups: ${bhgRows.length} total`)

  // ── 6. Build FRED arrays for velocity/momentum/percentile features ──
  console.log('[lean-dataset] Building FRED arrays for derived features...')

  const buildArr = (column: string): (number | null)[] => {
    const data = fredLookups.get(column)
    if (!data) return new Array(candles.length).fill(null)
    const lagDays = FRED_LAG_BY_COLUMN.get(column) ?? 1
    return buildFredArray(candles, data.lookup, data.sortedKeys, lagDays, dateKeyUtc, asofLookupByDateKey)
  }

  const vixArr = buildArr('fred_vix')
  const y10yArr = buildArr('fred_y10y')
  const y2yArr = buildArr('fred_y2y')
  const y30yArr = buildArr('fred_y30y')
  const dxyArr = buildArr('fred_dxy')
  const hyOasArr = buildArr('fred_hy_oas')
  const igOasArr = buildArr('fred_ig_oas')
  const eurusdArr = buildArr('fred_eurusd')
  const jpyusdArr = buildArr('fred_jpyusd')
  const wtiArr = buildArr('fred_wti')
  const copperArr = buildArr('fred_copper')
  const fedAssetsArr = buildArr('fred_fed_assets')
  const rrpArr = buildArr('fred_rrp')
  const claimsArr = buildArr('fred_claims')
  const tips10yArr = buildArr('fred_tips10y')
  const sofrArr = buildArr('fred_sofr')

  console.log('[lean-dataset] Built 16 FRED arrays for velocity/stationary features')

  // ── 7. Precompute MES technical indicators ──
  console.log('[lean-dataset] Computing technical indicators...')

  const closes = candles.map((c) => c.close)
  const volumes = candles.map((c) => Number(c.volume ?? 0))

  const edss14 = computeEDSSLean(closes)
  const ma8 = rollingMean(closes, 8)
  const ma24 = rollingMean(closes, 24)
  const ma120 = rollingMean(closes, 120)
  const std8 = rollingStd(closes, 8)
  const std24 = rollingStd(closes, 24)
  const std120 = rollingStd(closes, 120)
  const { min: lo24, max: hi24 } = rollingMinMax(closes, 24)
  const { min: lo120, max: hi120 } = rollingMinMax(closes, 120)
  const volMa24 = rollingMean(volumes, 24)

  // ── 7a. Squeeze Pro + Williams Vix Fix ──
  console.log('[lean-dataset] Computing Squeeze Pro & Williams Vix Fix...')
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  const sqz = computeSqueezePro(closes, highs, lows, 20)
  const wvf = computeWilliamsVixFix(closes, lows)
  console.log(`  Squeeze Pro: ${sqz.mom.filter(v => v != null).length} bars with momentum`)
  console.log(`  WVF: ${wvf.wvf.filter(v => v != null).length} bars, ${wvf.signal.filter(v => v === 1).length} fear spikes`)

  // ── 7b. Precompute cross-asset technical indicators ──
  // For each symbol: ret_1h, ret_4h, ret_24h, rsi14, dist_ma24, vol_ratio
  interface CrossAssetTechnicals {
    ret1h: (number | null)[]
    ret4h: (number | null)[]
    ret24h: (number | null)[]
    edss14: (number | null)[]
    distMa24: (number | null)[]
    volRatio: (number | null)[]
  }

  const crossAssetTech = new Map<string, CrossAssetTechnicals>()
  for (const sym of CROSS_ASSET_SYMBOLS) {
    const symCloses = crossAssetAligned.get(sym.code)!
    const symVols = crossAssetVolAligned.get(sym.code)!

    // Fill nulls for RSI/MA computation (forward-fill within array)
    const filledCloses: number[] = []
    let lastClose = 0
    for (const v of symCloses) {
      if (v != null) { lastClose = v; filledCloses.push(v) }
      else filledCloses.push(lastClose)
    }

    const symRsi14 = computeEDSSLean(filledCloses)
    const symMa24 = rollingMean(filledCloses, 24)
    // Null-aware volume MA: only average non-null bars, require at least 12/24
    const symVolMa24: (number | null)[] = new Array(symVols.length).fill(null)
    for (let j = 23; j < symVols.length; j++) {
      let sum = 0, cnt = 0
      for (let k = j - 23; k <= j; k++) {
        if (symVols[k] != null) { sum += symVols[k]!; cnt++ }
      }
      symVolMa24[j] = cnt >= 12 ? sum / cnt : null
    }

    const ret1h: (number | null)[] = []
    const ret4h: (number | null)[] = []
    const ret24h: (number | null)[] = []
    const distMa24: (number | null)[] = []
    const volRatio: (number | null)[] = []

    for (let i = 0; i < symCloses.length; i++) {
      const cur = symCloses[i]
      const prev1 = i >= 1 ? symCloses[i - 1] : null
      const prev4 = i >= 4 ? symCloses[i - 4] : null
      const prev24 = i >= 24 ? symCloses[i - 24] : null
      const ma = symMa24[i]
      const volMa = symVolMa24[i]
      const vol = symVols[i]

      ret1h.push(cur != null && prev1 != null && prev1 !== 0 ? (cur - prev1) / Math.abs(prev1) : null)
      ret4h.push(cur != null && prev4 != null && prev4 !== 0 ? (cur - prev4) / Math.abs(prev4) : null)
      ret24h.push(cur != null && prev24 != null && prev24 !== 0 ? (cur - prev24) / Math.abs(prev24) : null)
      distMa24.push(cur != null && ma != null && ma !== 0 ? (cur - ma) / ma : null)
      volRatio.push(vol != null && volMa != null && volMa > 0 ? vol / volMa : null)

      // Mask EDSS if underlying close was null (no bar) or previous was null (gap recovery)
      if (symCloses[i] == null || (i >= 1 && symCloses[i - 1] == null)) {
        symRsi14[i] = null
      }
    }

    crossAssetTech.set(sym.code, {
      ret1h,
      ret4h,
      ret24h,
      edss14: symRsi14,
      distMa24,
      volRatio,
    })
  }

  console.log(`[lean-dataset] Cross-asset technicals computed for ${CROSS_ASSET_SYMBOLS.length} symbols`)

  // ── 7c. CM Ultimate MACD ──
  console.log('[lean-dataset] Computing CM Ultimate MACD...')
  const macd = computeCmMacdVectorized(closes, 12, 26, 9)
  console.log(`  MACD: ${macd.line.filter(v => v != null).length} bars with values`)

  // ── 7d. Cross-asset rolling correlations ──
  console.log('[lean-dataset] Computing cross-asset rolling correlations...')
  // MES 1h returns for correlation computation
  const mesRet1hArr: (number | null)[] = candles.map((c, i) =>
    i >= 1 && candles[i - 1].close !== 0
      ? (c.close - candles[i - 1].close) / Math.abs(candles[i - 1].close)
      : null
  )
  const CORR_WINDOW = 21
  const mesNqCorr = rollingPearsonCorr(mesRet1hArr, crossAssetTech.get('NQ')!.ret1h, CORR_WINDOW)
  const mesClCorr = rollingPearsonCorr(mesRet1hArr, crossAssetTech.get('CL')!.ret1h, CORR_WINDOW)
  const mesE6Corr = rollingPearsonCorr(mesRet1hArr, crossAssetTech.get('6E')!.ret1h, CORR_WINDOW)
  const mesZnCorr = rollingPearsonCorr(mesRet1hArr, crossAssetTech.get('ZN')!.ret1h, CORR_WINDOW)
  console.log(`  Correlations: MES-NQ ${mesNqCorr.filter(v => v != null).length}, MES-CL ${mesClCorr.filter(v => v != null).length}, MES-6E ${mesE6Corr.filter(v => v != null).length}, MES-ZN ${mesZnCorr.filter(v => v != null).length}`)

  // ── 7e. Vol acceleration features ──
  console.log('[lean-dataset] Computing vol acceleration features...')
  // vol_of_vol: rolling std of std24 over 24 bars (NaN-aware, no zero-fill)
  // rollingStd requires number[], so filter nulls within window manually
  const volOfVol: (number | null)[] = new Array(candles.length).fill(null)
  for (let i = 47; i < candles.length; i++) {  // need 24 bars of std24, std24 needs 24 bars warmup
    const vals: number[] = []
    for (let j = i - 23; j <= i; j++) {
      if (std24[j] != null) vals.push(std24[j]!)
    }
    if (vals.length < 12) continue  // need at least half the window
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length
    volOfVol[i] = Math.sqrt(variance)
  }
  console.log(`  Vol-of-vol: ${volOfVol.filter(v => v != null).length} bars`)

  // ── 8. Assemble feature matrix ──
  console.log('[lean-dataset] Assembling lean feature matrix...')

  // Forward target horizons depend on timeframe
  const targetHorizons = timeframe === '15m'
    ? { '15m': 1, '1h': 4, '4h': 16 }
    : { '1h': 1, '4h': 4 }
  const targetCols = Object.keys(targetHorizons).map(h => `target_ret_${h}`)
  // Directional classification targets (1=up, 0=down/flat)
  const targetDirCols = Object.keys(targetHorizons).map(h => `target_dir_${h}`)
  // Vol-normalized return targets (ret / rolling_std24)
  const targetNormCols = Object.keys(targetHorizons).map(h => `target_ret_norm_${h}`)

  const header: string[] = [
    'item_id', 'timestamp', 'target',
    ...targetCols,
    ...targetDirCols,
    ...targetNormCols,
    // Time features (5)
    'hour_utc', 'day_of_week', 'is_us_session', 'is_asia_session', 'is_europe_session',
    // MES technicals (19) — NO raw price levels (ma8/24/120 removed, dist_ma stays)
    'mes_ret_1h', 'mes_ret_4h', 'mes_ret_8h', 'mes_ret_24h',
    'mes_range', 'mes_body_ratio',
    'mes_edss',
    'mes_dist_ma8', 'mes_dist_ma24', 'mes_dist_ma120',
    'mes_std8', 'mes_std24', 'mes_std120',
    'mes_dist_hi24', 'mes_dist_lo24', 'mes_dist_hi120', 'mes_dist_lo120',
    'mes_vol_ratio',
    // Squeeze Pro (5) — volatility compression → expansion
    'sqz_mom',             // momentum oscillator (linreg of price - midline)
    'sqz_mom_rising',      // 1 if momentum increasing, 0 if decreasing
    'sqz_mom_positive',    // 1 if momentum > 0
    'sqz_state',           // 0=none, 1=wide, 2=normal, 3=narrow, 4=fired
    'sqz_bars_in_squeeze', // consecutive bars in any squeeze state (1/2/3)
    // Williams Vix Fix (3) — synthetic VIX from price structure
    'wvf_value',           // raw WVF (higher = more fear)
    'wvf_signal',          // 1 = fear spike (above BB or percentile), 0 = normal
    'wvf_percentile',      // wvf / rangeHigh — fear intensity (0-2 scale)
    // CM Ultimate MACD (6) — ChrisMoody momentum
    'macd_line',           // fast EMA - slow EMA
    'macd_signal',         // SMA-9 of MACD line
    'macd_hist',           // line - signal (histogram)
    'macd_hist_color',     // 0=aqua 1=blue 2=red 3=maroon
    'macd_above_signal',   // 1 if line >= signal
    'macd_hist_rising',    // 1 if histogram increasing
    // Vol acceleration (3) — volatility regime features
    'vol_accel',           // std8 / std8[t-8] — vol acceleration (>1 = increasing)
    'vol_regime',          // std24 / std120 — short vs long-term vol
    'vol_of_vol',          // rolling std of std24 — volatility of volatility
    // FRED stationary (NO raw levels — all changes, diffs, ratios, z-scores)
    // Macro context — cross-sectional spreads (4)
    'yield_curve_slope', 'credit_spread_diff', 'real_rate_10y', 'fed_liquidity',
    // Macro context — levels that are mean-reverting / bounded (2)
    'fed_midpoint',        // fed funds target midpoint (bounded by policy)
    'fred_vix',            // VIX is mean-reverting by construction
    // Macro velocity — 1d changes (8)
    'vix_1d_change',       // VIX point change
    'y2y_1d_change',       // 2Y yield change
    'y10y_1d_change',      // 10Y yield change
    'y30y_1d_change',      // 30Y yield change
    'sofr_1d_change',      // SOFR rate change
    'ig_oas_1d_change',    // IG credit spread change
    'hy_oas_1d_change',    // HY credit spread change
    'tips10y_1d_change',   // TIPS 10Y change
    // Macro velocity — 5d momentum (6)
    'dgs10_velocity_5d', 'dollar_momentum_5d', 'hy_spread_momentum_5d',
    'eurusd_momentum_5d', 'jpyusd_momentum_5d', 'wti_momentum_5d',
    // Macro regime — percentiles (2)
    'vix_percentile_20d',
    'claims_percentile_20d',
    // Macro flow — changes (3)
    'fed_assets_change_1w', // weekly fed balance sheet change (billions)
    'rrp_change_1d',        // daily reverse repo change
    'claims_change_1w',     // weekly jobless claims change
    // Calendar + event timing (6)
    'is_fomc_day', 'is_high_impact_day', 'is_cpi_day', 'is_nfp_day',
    'events_this_week_count', 'hours_to_next_high_impact',
    // Release signal proxies (7) — z-scored release deltas from econ_calendar actuals
    'nfp_release_z', 'cpi_release_z', 'retail_sales_release_z', 'ppi_release_z',
    'gdp_release_z', 'claims_release_z', 'econ_surprise_index',
    // News/event regime (8) — from econ_calendar + econ_news_1d + policy_news_1d
    'cal_events_total_7d',      // total scheduled econ events
    'cal_events_high_7d',       // high-impact events only
    'cal_rate_events_7d',       // rates + rate_decision events
    'cal_inflation_events_7d',  // inflation events
    'cal_employment_events_7d', // employment events
    'econ_news_volume_7d',      // econ news articles (FRED blog, BEA, EIA)
    'policy_news_volume_7d',    // policy/regulatory news (Fed, SEC, ECB, CFTC)
    'news_total_volume_7d',     // combined econ + policy news
    // BHG rolling setup counts (2)
    'bhg_setups_count_7d', 'bhg_setups_count_30d',
    // Cross-asset technicals (6 symbols × 6 = 36)
    ...CROSS_ASSET_SYMBOLS.flatMap(sym => [
      `${sym.prefix}_ret_1h`,
      `${sym.prefix}_ret_4h`,
      `${sym.prefix}_ret_24h`,
      `${sym.prefix}_edss`,
      `${sym.prefix}_dist_ma24`,
      `${sym.prefix}_vol_ratio`,
    ]),
    // Derived regime features (5)
    'nq_minus_mes',        // tech premium vs broad market
    'yield_proxy',         // -ret(ZN) — rate impulse direction
    'usd_shock',           // -ret(6E) — dollar liquidity
    'carry_stress',        // abs(ret(6J)) — carry unwind magnitude
    'mes_zn_corr_21d',     // rolling 21-day MES vs ZN correlation
    // Cross-asset correlations + concordance (6)
    'mes_nq_corr_21d',    // MES vs NQ rolling correlation
    'mes_cl_corr_21d',    // MES vs CL rolling correlation
    'mes_e6_corr_21d',    // MES vs 6E rolling correlation
    'concordance_1h',     // count of cross-asset symbols with same-sign ret as MES (0-8)
    'equity_bond_diverge', // 1 if NQ and ZN move same direction (unusual)
    'corr_regime_count',  // count of positive correlations (breadth)
  ]

  console.log(`[lean-dataset] Header: ${header.length} columns`)

  const rows: string[][] = []
  let nextHighImpactIdx = 0
  const eventSignalWeights = EVENT_SIGNAL_CONFIGS.map((config) => config.weight)

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const ts = c.eventTime
    const close = c.close

    // Forward return targets
    const targets: (number | null)[] = Object.values(targetHorizons).map(offset =>
      i + offset < candles.length ? pctChange(candles[i + offset].close, close) : null
    )
    // Directional targets: 1 if return > 0, else 0
    const targetDirs: (number | null)[] = targets.map(t => t != null ? (t > 0 ? 1 : 0) : null)
    // Vol-normalized targets: return / rolling_std24 (removes heteroskedasticity)
    const vol24 = std24[i]
    const targetNorms: (number | null)[] = targets.map(t =>
      t != null && vol24 != null && vol24 > 0 ? t / vol24 : null
    )
    // Time features
    const hourUtc = ts.getUTCHours()
    const dayOfWeek = ts.getUTCDay()
    const isUsSession = hourUtc >= 13 && hourUtc < 21 ? 1 : 0
    const isAsiaSession = hourUtc >= 0 && hourUtc < 7 ? 1 : 0
    const isEuropeSession = hourUtc >= 7 && hourUtc < 13 ? 1 : 0

    // MES technicals
    const ret1h = i >= 1 ? pctChange(close, candles[i - 1].close) : null
    const ret4h = i >= 4 ? pctChange(close, candles[i - 4].close) : null
    const ret8h = i >= 8 ? pctChange(close, candles[i - 8].close) : null
    const ret24h = i >= 24 ? pctChange(close, candles[i - 24].close) : null
    const range = c.high > 0 ? (c.high - c.low) / c.close : null
    const bodyRatio = c.high !== c.low ? Math.abs(c.close - c.open) / (c.high - c.low) : null
    const distMa8 = ma8[i] != null ? (close - ma8[i]!) / ma8[i]! : null
    const distMa24 = ma24[i] != null ? (close - ma24[i]!) / ma24[i]! : null
    const distMa120 = ma120[i] != null ? (close - ma120[i]!) / ma120[i]! : null
    const distHi24 = hi24[i] != null ? (close - hi24[i]!) / hi24[i]! : null
    const distLo24 = lo24[i] != null ? (close - lo24[i]!) / lo24[i]! : null
    const distHi120 = hi120[i] != null ? (close - hi120[i]!) / hi120[i]! : null
    const distLo120 = lo120[i] != null ? (close - lo120[i]!) / lo120[i]! : null
    const volRatio = volMa24[i] != null && volMa24[i]! > 0 ? volumes[i] / volMa24[i]! : null

    // Squeeze Pro features
    const sqzMom = sqz.mom[i]
    const sqzMomPrev = i > 0 ? sqz.mom[i - 1] : null
    const sqzMomRising = sqzMom != null && sqzMomPrev != null ? (sqzMom > sqzMomPrev ? 1 : 0) : null
    const sqzMomPositive = sqzMom != null ? (sqzMom > 0 ? 1 : 0) : null
    const sqzState = sqz.state[i]
    // Count consecutive bars in squeeze (state 1, 2, or 3)
    let sqzBarsInSqueeze = 0
    if (sqzState != null && sqzState >= 1 && sqzState <= 3) {
      sqzBarsInSqueeze = 1
      for (let j = i - 1; j >= 0; j--) {
        const s = sqz.state[j]
        if (s != null && s >= 1 && s <= 3) sqzBarsInSqueeze++
        else break
      }
    }

    // Williams Vix Fix features
    const wvfValue = wvf.wvf[i]
    const wvfSignal = wvf.signal[i]
    const wvfPercentile = wvf.percentile[i]

    // CM Ultimate MACD features
    const macdLine = macd.line[i]
    const macdSignalVal = macd.signal[i]
    const macdHist = macd.hist[i]
    const macdHistColor = macd.histColor[i]
    const macdAboveSignal = macd.aboveSignal[i]
    const macdHistRising = macd.histRising[i]

    // Vol acceleration features
    const std8Prev = i >= 8 ? std8[i - 8] : null
    const volAccel = std8[i] != null && std8Prev != null && std8Prev > 0 ? std8[i]! / std8Prev : null
    const volRegime = std24[i] != null && std120[i] != null && std120[i]! > 0 ? std24[i]! / std120[i]! : null
    const volOfVolVal = volOfVol[i]

    // FRED as-of lookups (point-in-time with conservative lag)
    const laggedTargetKeyCache = new Map<number, string>()
    const laggedTargetKey = (lagDays: number): string => {
      const cached = laggedTargetKeyCache.get(lagDays)
      if (cached) return cached
      const key = dateKeyUtc(new Date(ts.getTime() - lagDays * 24 * 60 * 60 * 1000))
      laggedTargetKeyCache.set(lagDays, key)
      return key
    }

    const fredValues: (number | null)[] = FRED_FEATURES.map((f) => {
      const data = fredLookups.get(f.column)
      if (!data) return null
      const lagDays = FRED_LAG_BY_COLUMN.get(f.column) ?? 1
      return asofLookupByDateKey(data.lookup, data.sortedKeys, laggedTargetKey(lagDays))
    })

    // Derived — macro context
    const y2y = fredValues[IDX_Y2Y]
    const y10y = fredValues[IDX_Y10Y]
    const igOas = fredValues[IDX_IG_OAS]
    const hyOas = fredValues[IDX_HY_OAS]
    const vix = fredValues[IDX_VIX]
    const tips10y = fredValues[IDX_TIPS10Y]
    const fedAssets = fredValues[IDX_FED_ASSETS]
    const rrp = fredValues[IDX_RRP]
    const fedTargetLower = fredValues[IDX_FED_TARGET_LOWER]
    const fedTargetUpper = fredValues[IDX_FED_TARGET_UPPER]

    const yieldCurveSlope = y10y != null && y2y != null ? y10y - y2y : null
    const creditSpreadDiff = hyOas != null && igOas != null ? hyOas - igOas : null
    // Real rate 10y: nominal 10Y minus TIPS 10Y
    const realRate10y = y10y != null && tips10y != null ? y10y - tips10y : null
    const fedLiquidity = fedAssets != null && rrp != null ? fedAssets - rrp * 1000 : null

    // Derived — velocity/regime features (from FRED arrays) — ALL stationary
    const fedMidpoint = fedTargetLower != null && fedTargetUpper != null
      ? (fedTargetLower + fedTargetUpper) / 2 : null
    // 1d changes (point deltas for rates/spreads)
    const vix1dChange = deltaBack(vixArr, i, barsPerDay)
    const y2y1dChange = deltaBack(y2yArr, i, barsPerDay)
    const y10y1dChange = deltaBack(y10yArr, i, barsPerDay)
    const y30y1dChange = deltaBack(y30yArr, i, barsPerDay)
    const sofr1dChange = deltaBack(sofrArr, i, barsPerDay)
    const igOas1dChange = deltaBack(igOasArr, i, barsPerDay)
    const hyOas1dChange = deltaBack(hyOasArr, i, barsPerDay)
    const tips10y1dChange = deltaBack(tips10yArr, i, barsPerDay)
    // 5d momentum (pct changes for prices, point deltas for rates)
    const dgs10Velocity5d = deltaBack(y10yArr, i, velocityLookback)
    const dollarMomentum5d = pctDeltaBack(dxyArr, i, velocityLookback)
    const hySpreadMomentum5d = deltaBack(hyOasArr, i, velocityLookback)
    const eurusdMomentum5d = pctDeltaBack(eurusdArr, i, velocityLookback)
    const jpyusdMomentum5d = pctDeltaBack(jpyusdArr, i, velocityLookback)
    const wtiMomentum5d = pctDeltaBack(wtiArr, i, velocityLookback)
    // Percentiles (regime context)
    const vixPercentile20d = rollingPercentile(vixArr, i, 20 * barsPerDay)
    const claimsPercentile20d = rollingPercentile(claimsArr, i, 20 * barsPerDay)
    // Flow changes (weekly/daily magnitude changes)
    const fedAssetsChange1w = deltaBack(fedAssetsArr, i, 7 * barsPerDay)
    const rrpChange1d = deltaBack(rrpArr, i, barsPerDay)
    const claimsChange1w = deltaBack(claimsArr, i, 7 * barsPerDay)

    // Calendar + event timing
    const todayKey = dateKeyUtc(ts)
    const todayEvents = calendarLookup.get(todayKey) || []
    const isFomcDay = todayEvents.some((event) => {
      const eventName = event.eventName.toUpperCase()
      const eventType = event.eventType.toUpperCase()
      return (
        eventName.includes('FOMC') ||
        eventType.includes('FOMC') ||
        eventName.includes('FEDERAL FUNDS') ||
        eventType.includes('RATE_DECISION')
      )
    }) ? 1 : 0
    const isHighImpactDay = todayEvents.some((event) => event.impactRating?.toLowerCase() === 'high') ? 1 : 0
    const isCpiDay = todayEvents.some((event) => event.eventName.toUpperCase().includes('CPI')) ? 1 : 0
    const isNfpDay = todayEvents.some((event) => event.eventName.toUpperCase().includes('NFP')) ? 1 : 0
    const eventsThisWeekCount = centeredCount(ts, calendarCountsByDate, 3, 3)

    const tsMs = ts.getTime()
    while (nextHighImpactIdx < highImpactReleaseTimesMs.length && highImpactReleaseTimesMs[nextHighImpactIdx] < tsMs) {
      nextHighImpactIdx += 1
    }
    const hoursToNextHighImpact = nextHighImpactIdx < highImpactReleaseTimesMs.length
      ? (highImpactReleaseTimesMs[nextHighImpactIdx] - tsMs) / (60 * 60 * 1000)
      : null

    // Release signal proxies (z-scored release deltas from econ_calendar actuals)
    const releaseSignalValues = EVENT_SIGNAL_CONFIGS.map((config) => {
      const signal = eventSignalLookups.get(config.column)
      if (!signal) return null
      return asofLookupByDateKey(signal.lookup, signal.sortedKeys, laggedTargetKey(EVENT_FEATURE_LAG_DAYS))
    })
    const [
      nfpReleaseZ,
      cpiReleaseZ,
      retailSalesReleaseZ,
      ppiReleaseZ,
      gdpReleaseZ,
      claimsReleaseZ,
    ] = releaseSignalValues
    const econSurpriseIndex = weightedAverage(releaseSignalValues, eventSignalWeights)

    // News/event regime — from real historical tables (econ_calendar + econ_news_1d + policy_news_1d)
    const calEventsTotal7d = trailingCountLagged(ts, calEventsTotalByDate, 7, 1)
    const calEventsHigh7d = trailingCountLagged(ts, calEventsHighByDate, 7, 1)
    const calRateEvents7d = trailingCountLagged(ts, calRateEventsByDate, 7, 1)
    const calInflationEvents7d = trailingCountLagged(ts, calInflationEventsByDate, 7, 1)
    const calEmploymentEvents7d = trailingCountLagged(ts, calEmploymentEventsByDate, 7, 1)
    const econNewsVolume7d = trailingCountLagged(ts, econNewsVolumeByDate, 7, 1)
    const policyNewsVolume7d = trailingCountLagged(ts, policyNewsVolumeByDate, 7, 1)
    const newsTotalVolume7d = trailingCountLagged(ts, newsTotalVolumeByDate, 7, 1)

    // BHG rolling setup counts (strictly historical + 24h resolution lag)
    const bhgSetupsCount7d = countInTimeRange(
      bhgAllGoTimesMs,
      tsMs - 7 * MS_PER_DAY,
      tsMs - BHG_RESOLUTION_LAG_MS
    )
    const bhgSetupsCount30d = countInTimeRange(
      bhgAllGoTimesMs,
      tsMs - 30 * MS_PER_DAY,
      tsMs - BHG_RESOLUTION_LAG_MS
    )

    // ── ASSEMBLE ROW ──
    // CRITICAL: order MUST match header exactly
    const row: (string | number | null)[] = [
      `MES_${timeframe.toUpperCase()}`,               // item_id
      ts.toISOString(),                                // timestamp
      close,                                           // target
      ...targets,                                      // forward return targets
      ...targetDirs,                                   // directional targets (1=up, 0=down)
      ...targetNorms,                                  // vol-normalized return targets
      // Time features (5)
      hourUtc, dayOfWeek, isUsSession, isAsiaSession, isEuropeSession,
      // MES technicals (19) — no raw price levels
      ret1h, ret4h, ret8h, ret24h,
      range, bodyRatio,
      edss14[i],
      distMa8, distMa24, distMa120,
      std8[i], std24[i], std120[i],
      distHi24, distLo24, distHi120, distLo120,
      volRatio,
      // Squeeze Pro (5)
      sqzMom, sqzMomRising, sqzMomPositive, sqzState, sqzBarsInSqueeze,
      // Williams Vix Fix (3)
      wvfValue, wvfSignal, wvfPercentile,
      // CM Ultimate MACD (6)
      macdLine, macdSignalVal, macdHist, macdHistColor, macdAboveSignal, macdHistRising,
      // Vol acceleration (3)
      volAccel, volRegime, volOfVolVal,
      // FRED stationary — macro context (4)
      yieldCurveSlope, creditSpreadDiff, realRate10y, fedLiquidity,
      // FRED stationary — bounded levels (2)
      fedMidpoint, vix,
      // FRED stationary — 1d changes (8)
      vix1dChange, y2y1dChange, y10y1dChange, y30y1dChange,
      sofr1dChange, igOas1dChange, hyOas1dChange, tips10y1dChange,
      // FRED stationary — 5d momentum (6)
      dgs10Velocity5d, dollarMomentum5d, hySpreadMomentum5d,
      eurusdMomentum5d, jpyusdMomentum5d, wtiMomentum5d,
      // FRED stationary — regime percentiles (2)
      vixPercentile20d, claimsPercentile20d,
      // FRED stationary — flow changes (3)
      fedAssetsChange1w, rrpChange1d, claimsChange1w,
      // Calendar + event timing (6)
      isFomcDay, isHighImpactDay, isCpiDay, isNfpDay,
      eventsThisWeekCount, hoursToNextHighImpact,
      // Release signal proxies (7)
      nfpReleaseZ, cpiReleaseZ, retailSalesReleaseZ, ppiReleaseZ,
      gdpReleaseZ, claimsReleaseZ, econSurpriseIndex,
      // News/event regime (8)
      calEventsTotal7d, calEventsHigh7d, calRateEvents7d, calInflationEvents7d, calEmploymentEvents7d,
      econNewsVolume7d, policyNewsVolume7d, newsTotalVolume7d,
      // BHG rolling setup counts (2)
      bhgSetupsCount7d, bhgSetupsCount30d,
      // Cross-asset technicals (6 symbols × 6 = 36)
      ...CROSS_ASSET_SYMBOLS.flatMap(sym => {
        const tech = crossAssetTech.get(sym.code)!
        return [
          tech.ret1h[i],
          tech.ret4h[i],
          tech.ret24h[i],
          tech.edss14[i],
          tech.distMa24[i],
          tech.volRatio[i],
        ]
      }),
      // Derived regime features (5)
      (() => {
        // nq_minus_mes: NQ ret_1h − MES ret_1h
        const nq = crossAssetTech.get('NQ')!.ret1h[i]
        const mesRet = i >= 1 && candles[i - 1].close !== 0
          ? (close - candles[i - 1].close) / Math.abs(candles[i - 1].close)
          : null
        return nq != null && mesRet != null ? nq - mesRet : null
      })(),
      (() => {
        // yield_proxy: -ret(ZN)
        const znRet = crossAssetTech.get('ZN')!.ret1h[i]
        return znRet != null ? -znRet : null
      })(),
      (() => {
        // usd_shock: -ret(6E)
        const e6Ret = crossAssetTech.get('6E')!.ret1h[i]
        return e6Ret != null ? -e6Ret : null
      })(),
      (() => {
        // carry_stress: abs(ret(6J))
        const j6Ret = crossAssetTech.get('6J')!.ret1h[i]
        return j6Ret != null ? Math.abs(j6Ret) : null
      })(),
      mesZnCorr[i],  // mes_zn_corr_21d (pre-computed)
      // Cross-asset correlations + concordance (6)
      mesNqCorr[i],
      mesClCorr[i],
      mesE6Corr[i],
      // concordance_1h: count of cross-asset symbols with same-sign ret as MES
      (() => {
        const mesR = mesRet1hArr[i]
        if (mesR == null || mesR === 0) return null
        const mesSign = mesR > 0 ? 1 : -1
        let count = 0
        for (const sym of CROSS_ASSET_SYMBOLS) {
          const r = crossAssetTech.get(sym.code)!.ret1h[i]
          if (r != null && r !== 0) {
            if ((r > 0 ? 1 : -1) === mesSign) count++
          }
        }
        return count
      })(),
      // equity_bond_diverge: 1 if NQ and ZN move same direction (unusual)
      (() => {
        const nqR = crossAssetTech.get('NQ')!.ret1h[i]
        const znR = crossAssetTech.get('ZN')!.ret1h[i]
        if (nqR == null || znR == null || nqR === 0 || znR === 0) return null
        return (nqR > 0) === (znR > 0) ? 1 : 0
      })(),
      // corr_regime_count: count of positive correlations (breadth)
      (() => {
        const corrs = [mesNqCorr[i], mesClCorr[i], mesE6Corr[i], mesZnCorr[i]]
        const valid = corrs.filter(c => c != null) as number[]
        if (valid.length < 2) return null
        return valid.filter(c => c > 0).length
      })(),
    ]

    // Sanity check: row length must match header
    if (i === 0 && row.length !== header.length) {
      throw new Error(`ROW/HEADER MISMATCH: row has ${row.length} values, header has ${header.length} columns. Fix before proceeding.`)
    }

    rows.push(row.map((v) => {
      if (v == null) return ''
      const s = String(v)
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
      return s
    }))
  }

  // ── 7. Write CSV ──
  const outPath = path.resolve(outFile)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  const csvLines = [header.join(','), ...rows.map((r) => r.join(','))]
  fs.writeFileSync(outPath, csvLines.join('\n') + '\n', 'utf8')

  // ── 8. Summary ──
  const nonNullCounts: Record<string, number> = {}
  for (let col = 0; col < header.length; col++) {
    nonNullCounts[header[col]] = rows.filter((r) => r[col] !== '').length
  }

  console.log(`\n[lean-dataset] ✅ Written ${rows.length} rows × ${header.length} features to ${outFile}`)
  console.log(`[lean-dataset] Date range: ${rows[0][1]} → ${rows[rows.length - 1][1]}`)

  const derivedCols = [
    'yield_curve_slope', 'credit_spread_diff', 'real_rate_10y', 'fed_liquidity',
    'fed_midpoint', 'fred_vix',
    'vix_1d_change', 'y2y_1d_change', 'y10y_1d_change', 'y30y_1d_change',
    'sofr_1d_change', 'ig_oas_1d_change', 'hy_oas_1d_change', 'tips10y_1d_change',
    'dgs10_velocity_5d', 'dollar_momentum_5d', 'hy_spread_momentum_5d',
    'eurusd_momentum_5d', 'jpyusd_momentum_5d', 'wti_momentum_5d',
    'vix_percentile_20d', 'claims_percentile_20d',
    'fed_assets_change_1w', 'rrp_change_1d', 'claims_change_1w',
    'is_fomc_day', 'is_high_impact_day', 'is_cpi_day', 'is_nfp_day',
    'events_this_week_count', 'hours_to_next_high_impact',
    'nfp_release_z', 'cpi_release_z', 'retail_sales_release_z', 'ppi_release_z',
    'gdp_release_z', 'claims_release_z', 'econ_surprise_index',
    'cal_events_total_7d', 'cal_events_high_7d', 'cal_rate_events_7d',
    'cal_inflation_events_7d', 'cal_employment_events_7d',
    'econ_news_volume_7d', 'policy_news_volume_7d', 'news_total_volume_7d',
    'bhg_setups_count_7d', 'bhg_setups_count_30d',
    'macd_line', 'macd_signal', 'macd_hist', 'macd_hist_color', 'macd_above_signal', 'macd_hist_rising',
    'vol_accel', 'vol_regime', 'vol_of_vol',
    'mes_zn_corr_21d', 'mes_nq_corr_21d', 'mes_cl_corr_21d', 'mes_e6_corr_21d',
    'concordance_1h', 'equity_bond_diverge', 'corr_regime_count',
  ]
  console.log(`\n[lean-dataset] Derived feature coverage:`)
  for (const col of derivedCols) {
    const idx = header.indexOf(col)
    const count = rows.filter((r) => r[idx] !== '').length
    const pct = ((count / rows.length) * 100).toFixed(1)
    console.log(`  ${col.padEnd(24)} ${String(count).padStart(7)} / ${rows.length} (${pct}%)`)
  }

  console.log(`\n[lean-dataset] Target coverage:`)
  for (const t of targetCols) {
    const idx = header.indexOf(t)
    const count = rows.filter((r) => r[idx] !== '').length
    console.log(`  ${t.padEnd(24)} ${count} / ${rows.length}`)
  }
}

run()
  .catch((error) => {
    console.error('[lean-dataset] FATAL:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
