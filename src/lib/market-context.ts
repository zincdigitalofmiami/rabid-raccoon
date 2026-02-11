/**
 * Market Context Engine
 *
 * Cross-asset correlations, market regime detection, rates context,
 * mega-cap tech breadth, and headline/theme scoring.
 */

import { CandleData } from './types'
import { fetchFedFundsCandles, getFredDateRange } from './fred'
import { fetchTechLeaderSnapshots } from './tech-leaders'

// --- Types ---

export interface CorrelationResult {
  pair: string
  value: number
  interpretation: string
}

export interface TechLeaderContext {
  symbol: string
  name: string
  price: number
  dayChangePercent: number
  weekChangePercent: number
  signal: string
}

export interface YieldContext {
  tenYearYield: number
  tenYearChangeBp: number
  fedFundsRate: number | null
  spread10yMinusFedBp: number | null
  signal: string
}

export interface ThemeScores {
  tariffs: number
  rates: number
  trump: number
  analysts: number
  aiTech: number
  eventRisk: number
}

export interface ShockReactions {
  vixSpikeSample: number
  vixSpikeAvgNextDayMesPct: number | null
  vixSpikeMedianNextDayMesPct: number | null
  yieldSpikeSample: number
  yieldSpikeAvgNextDayMesPct: number | null
  yieldSpikeMedianNextDayMesPct: number | null
}

export interface Breakout7000Context {
  level: number
  status:
    | 'CONFIRMED_BREAKOUT'
    | 'UNCONFIRMED_BREAKOUT'
    | 'REJECTED_AT_LEVEL'
    | 'TESTING_7000'
    | 'BELOW_7000'
  latestClose: number
  latestHigh: number
  distanceFromLevel: number
  lastTwoCloses: [number, number]
  closesAboveLevelLast2: number
  closesBelowLevelLast2: number
  consecutiveClosesAboveLevel: number
  consecutiveClosesBelowLevel: number
  twoCloseConfirmation: boolean
  signal: string
  tradePlan: string
}

export interface MarketContext {
  regime: 'RISK-ON' | 'RISK-OFF' | 'MIXED'
  regimeFactors: string[]
  correlations: CorrelationResult[]
  headlines: string[]
  goldContext: { price: number; change: number; changePercent: number; signal: string } | null
  oilContext: { price: number; change: number; changePercent: number; signal: string } | null
  yieldContext: YieldContext | null
  techLeaders: TechLeaderContext[]
  themeScores: ThemeScores
  shockReactions: ShockReactions
  breakout7000: Breakout7000Context | null
  intermarketNarrative: string
}

// --- Math helpers ---

function returns(closes: number[]): number[] {
  const r: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] !== 0) {
      r.push((closes[i] - closes[i - 1]) / closes[i - 1])
    }
  }
  return r
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 5) return 0
  const aa = a.slice(-n)
  const bb = b.slice(-n)
  const meanA = aa.reduce((s, v) => s + v, 0) / n
  const meanB = bb.reduce((s, v) => s + v, 0) / n
  let cov = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < n; i++) {
    const da = aa[i] - meanA
    const db = bb[i] - meanB
    cov += da * db
    varA += da * da
    varB += db * db
  }
  const denom = Math.sqrt(varA * varB)
  return denom === 0 ? 0 : cov / denom
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

function dateKey(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10)
}

// --- Correlation computation ---

function interpretCorrelation(symbol: string, corr: number): string {
  const abs = Math.abs(corr)
  const strength = abs > 0.7 ? 'Strong' : abs > 0.4 ? 'Moderate' : 'Weak'
  const dir = corr > 0 ? 'positive' : 'negative'

  if (symbol === 'NQ') {
    if (corr > 0.7) return `${strength} ${dir} — tech leadership confirms equity trend`
    if (corr > 0.4) return 'Moderate alignment — watch NQ for leadership/divergence'
    return 'Weak alignment — sector rotation risk'
  }
  if (symbol === 'VX') {
    if (corr < -0.5) return `${strength} inverse — normal equity/volatility relationship`
    if (corr > 0) return 'ABNORMAL: VIX rising with equities — hedging stress'
    return 'Weak inverse — volatility not fully confirming move'
  }
  if (symbol === 'US10Y') {
    if (corr < -0.3) return 'Yields inversely linked — rising rates pressuring equities'
    if (corr > 0.3) return 'Yields and equities aligned — growth/risk-on interpretation'
    return '10Y relationship currently weak/unstable'
  }
  if (symbol === 'ZN' || symbol === 'ZB') {
    if (corr < -0.4) return 'Bonds inverse — rotation between duration and equities'
    if (corr > 0.4) return 'Bonds and equities rising together — policy easing expectations'
    return 'Bond/equity tie is weak'
  }
  if (symbol === 'DX') {
    if (corr < -0.3) return 'Dollar inverse — weaker USD supportive for risk'
    if (corr > 0.3) return 'Dollar and equities rising together — unusual flow regime'
    return 'Dollar mostly independent'
  }
  if (symbol === 'GC') {
    if (corr < -0.3) return 'Gold inverse — classic risk-on tone'
    if (corr > 0.3) return 'Gold and equities both bid — inflation/uncertainty hedge'
    return 'Gold decoupled from equities'
  }
  if (symbol === 'CL') {
    if (corr > 0.4) return 'Oil positive with equities — demand/growth interpretation'
    if (corr < -0.3) return 'Oil inverse — stagflation/supply-shock risk'
    return 'Oil mostly idiosyncratic'
  }

  return `${strength} ${dir} correlation`
}

export function computeCorrelations(
  symbolCandles: Map<string, CandleData[]>
): CorrelationResult[] {
  const mesCandles = symbolCandles.get('MES')
  if (!mesCandles || mesCandles.length < 20) return []

  const mesRet = returns(mesCandles.map((c) => c.close))
  const results: CorrelationResult[] = []

  for (const [symbol, candles] of symbolCandles.entries()) {
    if (symbol === 'MES') continue
    const ret = returns(candles.map((c) => c.close))
    const corr = pearsonCorrelation(mesRet, ret)
    results.push({
      pair: `MES↔${symbol}`,
      value: Number(corr.toFixed(3)),
      interpretation: interpretCorrelation(symbol, corr),
    })
  }

  return results.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
}

// --- Regime detection ---

export function detectMarketRegime(
  changes: Map<string, number>
): { regime: 'RISK-ON' | 'RISK-OFF' | 'MIXED'; factors: string[] } {
  const factors: string[] = []
  let riskOnScore = 0

  const mes = changes.get('MES') || 0
  const nq = changes.get('NQ') || 0
  const vix = changes.get('VX') || 0
  const zn = changes.get('ZN') || 0
  const gc = changes.get('GC') || 0
  const cl = changes.get('CL') || 0
  const dx = changes.get('DX') || 0
  const us10y = changes.get('US10Y') || 0

  if (mes > 0.05) {
    riskOnScore += 2
    factors.push(`Equities bid: MES +${mes.toFixed(2)}%`)
  } else if (mes < -0.05) {
    riskOnScore -= 2
    factors.push(`Equities offered: MES ${mes.toFixed(2)}%`)
  } else {
    factors.push(`Equities flat: MES ${mes.toFixed(2)}%`)
  }

  if (Math.abs(nq) > 0.01 && Math.abs(mes) > 0.01) {
    if (nq > mes + 0.1) {
      riskOnScore += 1
      factors.push(`Tech leading: NQ outperforming MES by ${(nq - mes).toFixed(2)}%`)
    } else if (nq < mes - 0.1) {
      riskOnScore -= 1
      factors.push(`Tech lagging: NQ underperforming MES by ${(mes - nq).toFixed(2)}%`)
    }
  }

  if (vix < -1) {
    riskOnScore += 1
    factors.push(`Volatility compression: VIX ${vix.toFixed(2)}%`)
  } else if (vix > 1) {
    riskOnScore -= 2
    factors.push(`Volatility expansion: VIX +${vix.toFixed(2)}%`)
  } else if (vix !== 0) {
    factors.push(`VIX stable (${vix.toFixed(2)}%)`)
  }

  if (us10y > 1.0) {
    riskOnScore -= 1
    factors.push(`10Y yield rising ${us10y.toFixed(2)}% — tighter financial conditions`)
  } else if (us10y < -1.0) {
    riskOnScore += 1
    factors.push(`10Y yield falling ${us10y.toFixed(2)}% — easing pressure`)
  }

  if (zn < -0.05) {
    riskOnScore += 1
    factors.push(`Bonds offered: ZN ${zn.toFixed(2)}%`)
  } else if (zn > 0.05) {
    riskOnScore -= 1
    factors.push(`Bonds bid: ZN +${zn.toFixed(2)}%`)
  }

  if (gc < -0.1) {
    riskOnScore += 1
    factors.push(`Gold off ${gc.toFixed(2)}%`)
  } else if (gc > 0.3) {
    riskOnScore -= 1
    factors.push(`Gold bid +${gc.toFixed(2)}%`)
  }

  if (cl > 0.3) {
    factors.push(`Oil up +${cl.toFixed(2)}%`)
  } else if (cl < -0.3) {
    factors.push(`Oil down ${cl.toFixed(2)}%`)
  }

  if (dx > 0.1) {
    riskOnScore -= 1
    factors.push(`Dollar strengthening +${dx.toFixed(2)}%`)
  } else if (dx < -0.1) {
    riskOnScore += 1
    factors.push(`Dollar weakening ${dx.toFixed(2)}%`)
  }

  const regime = riskOnScore >= 2 ? 'RISK-ON' : riskOnScore <= -2 ? 'RISK-OFF' : 'MIXED'
  return { regime, factors }
}

// --- Commodity context ---

export function buildCommodityContext(
  candles: CandleData[]
): { price: number; change: number; changePercent: number; signal: string } | null {
  if (candles.length < 2) return null
  const price = candles[candles.length - 1].close
  const firstPrice = candles[0].close
  const change = price - firstPrice
  const changePercent = firstPrice > 0 ? (change / firstPrice) * 100 : 0
  let signal = ''
  if (changePercent > 0.5) signal = 'Bid — potential inflation/supply pressure'
  else if (changePercent < -0.5) signal = 'Offered — demand cooling / risk-on'
  else signal = 'Rangebound — neutral macro read'
  return { price, change, changePercent, signal }
}

// --- Headlines & theme scoring ---

export async function fetchMarketHeadlines(): Promise<string[]> {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) return []

  const releaseMatches = [
    'Consumer Price Index',
    'Employment Situation',
    'Producer Price Index',
    'Federal Open Market Committee',
    'Retail Sales',
  ]

  try {
    const releasesRes = await fetch(
      `https://api.stlouisfed.org/fred/releases?api_key=${encodeURIComponent(apiKey)}&file_type=json`,
      {
        headers: { 'User-Agent': 'RabidRaccoon/2.4' },
        signal: AbortSignal.timeout(5000),
      }
    )
    if (!releasesRes.ok) return []

    const releasesJson = await releasesRes.json() as {
      releases?: Array<{ id: number; name: string }>
    }
    const releases = releasesJson.releases || []
    const targets = releases.filter((r) =>
      releaseMatches.some((name) => r.name.toLowerCase().includes(name.toLowerCase()))
    )

    const lines: string[] = []
    for (const release of targets.slice(0, 6)) {
      try {
        const datesRes = await fetch(
          `https://api.stlouisfed.org/fred/release/dates?release_id=${release.id}&api_key=${encodeURIComponent(apiKey)}&file_type=json&sort_order=desc&limit=2`,
          {
            headers: { 'User-Agent': 'RabidRaccoon/2.4' },
            signal: AbortSignal.timeout(4000),
          }
        )
        if (!datesRes.ok) continue
        const datesJson = await datesRes.json() as {
          release_dates?: Array<{ date: string }>
        }
        const ds = (datesJson.release_dates || []).map((d) => d.date).filter(Boolean)
        if (ds.length === 0) continue
        lines.push(
          `${release.name}: latest release ${ds[0]}${ds[1] ? `; prior ${ds[1]}` : ''}`
        )
      } catch {
        // Continue with next release
      }
    }

    return lines
  } catch {
    return []
  }
}

function keywordScore(
  lines: string[],
  gate: string[],
  positive: string[],
  negative: string[]
): number {
  let score = 0
  for (const raw of lines) {
    const line = raw.toLowerCase()
    if (!gate.some((w) => line.includes(w))) continue
    if (positive.some((w) => line.includes(w))) score += 1
    if (negative.some((w) => line.includes(w))) score -= 1
  }
  return clamp(score * 20, -100, 100)
}

function computeThemeScores(headlines: string[]): ThemeScores {
  return {
    tariffs: keywordScore(
      headlines,
      ['tariff', 'trade', 'duty', 'china', 'mexico', 'canada'],
      ['pause', 'deal', 'easing', 'exemption', 'rollback'],
      ['escalat', 'retaliat', 'levy', 'hike', 'new tariff']
    ),
    rates: keywordScore(
      headlines,
      ['fed', 'rate', 'yield', 'treasury', 'inflation'],
      ['cut', 'dovish', 'disinflation', 'cooling', 'lower yield'],
      ['hike', 'hawkish', 'sticky inflation', 'higher yield', 'surge']
    ),
    trump: keywordScore(
      headlines,
      ['trump', 'white house', 'administration'],
      ['deal', 'pause', 'tax cut', 'deregulation'],
      ['tariff', 'standoff', 'sanction', 'escalation']
    ),
    analysts: keywordScore(
      headlines,
      ['analyst', 'strategist', 'broker', 'target', 'outlook'],
      ['upgrade', 'outperform', 'overweight', 'buy', 'raised target'],
      ['downgrade', 'underperform', 'sell', 'cut target', 'cautious']
    ),
    aiTech: keywordScore(
      headlines,
      ['ai', 'chip', 'semiconductor', 'cloud', 'nvidia', 'microsoft', 'apple', 'meta', 'amazon', 'alphabet', 'broadcom', 'oracle', 'amd'],
      ['beat', 'raised guidance', 'strong demand', 'accelerating', 'tailwind'],
      ['miss', 'cut guidance', 'slowdown', 'export curb', 'weak demand']
    ),
    eventRisk: keywordScore(
      headlines,
      ['cpi', 'pce', 'payroll', 'jobs report', 'fomc', 'fed minutes', 'inflation', 'nfp'],
      ['in line', 'cooling', 'soft landing', 'benign'],
      ['hotter', 'surprise rise', 'sticky', 'volatility', 'uncertain']
    ),
  }
}

// --- Rates & shock-reaction context ---

async function fetchLatestFedFundsRate(): Promise<number | null> {
  try {
    const range = getFredDateRange()
    const candles = await fetchFedFundsCandles(range.start, range.end)
    if (candles.length === 0) return null
    return candles[candles.length - 1].close
  } catch {
    return null
  }
}

function buildYieldContext(tenYearCandles: CandleData[], fedFundsRate: number | null): YieldContext | null {
  if (tenYearCandles.length < 2) return null
  const last = tenYearCandles[tenYearCandles.length - 1]
  const prev = tenYearCandles[tenYearCandles.length - 2]
  const tenYearChangeBp = (last.close - prev.close) * 100
  const spread10yMinusFedBp =
    fedFundsRate != null ? (last.close - fedFundsRate) * 100 : null

  let signal = 'Rates stable'
  if (tenYearChangeBp >= 8) signal = '10Y yield spike — risk of valuation compression'
  else if (tenYearChangeBp <= -8) signal = '10Y yield drop — potential multiple support'
  else if (tenYearChangeBp > 3) signal = 'Yields grinding higher — mild tightening'
  else if (tenYearChangeBp < -3) signal = 'Yields grinding lower — mild easing'

  return {
    tenYearYield: last.close,
    tenYearChangeBp: Number(tenYearChangeBp.toFixed(1)),
    fedFundsRate,
    spread10yMinusFedBp:
      spread10yMinusFedBp == null ? null : Number(spread10yMinusFedBp.toFixed(1)),
    signal,
  }
}

function computeShockReactions(
  mesCandles: CandleData[],
  vixCandles: CandleData[] | undefined,
  tenYearCandles: CandleData[] | undefined
): ShockReactions {
  const defaultValue: ShockReactions = {
    vixSpikeSample: 0,
    vixSpikeAvgNextDayMesPct: null,
    vixSpikeMedianNextDayMesPct: null,
    yieldSpikeSample: 0,
    yieldSpikeAvgNextDayMesPct: null,
    yieldSpikeMedianNextDayMesPct: null,
  }
  if (mesCandles.length < 10) return defaultValue

  const mesDates = mesCandles.map((c) => dateKey(c.time))
  const mesIdxByDate = new Map(mesDates.map((d, i) => [d, i]))

  const vixReactions: number[] = []
  if (vixCandles && vixCandles.length >= 10) {
    for (let i = 1; i < vixCandles.length; i++) {
      const prev = vixCandles[i - 1].close
      const curr = vixCandles[i].close
      if (prev <= 0) continue
      const pct = ((curr - prev) / prev) * 100
      if (pct < 8) continue

      const d = dateKey(vixCandles[i].time)
      const mesIdx = mesIdxByDate.get(d)
      if (mesIdx == null || mesIdx + 1 >= mesCandles.length) continue

      const mesNow = mesCandles[mesIdx].close
      const mesNext = mesCandles[mesIdx + 1].close
      if (mesNow <= 0) continue
      vixReactions.push(((mesNext - mesNow) / mesNow) * 100)
    }
  }

  const yieldReactions: number[] = []
  if (tenYearCandles && tenYearCandles.length >= 10) {
    for (let i = 1; i < tenYearCandles.length; i++) {
      const deltaBp = (tenYearCandles[i].close - tenYearCandles[i - 1].close) * 100
      if (deltaBp < 8) continue

      const d = dateKey(tenYearCandles[i].time)
      const mesIdx = mesIdxByDate.get(d)
      if (mesIdx == null || mesIdx + 1 >= mesCandles.length) continue

      const mesNow = mesCandles[mesIdx].close
      const mesNext = mesCandles[mesIdx + 1].close
      if (mesNow <= 0) continue
      yieldReactions.push(((mesNext - mesNow) / mesNow) * 100)
    }
  }

  const vixAvg =
    vixReactions.length > 0
      ? vixReactions.reduce((s, v) => s + v, 0) / vixReactions.length
      : null
  const yieldAvg =
    yieldReactions.length > 0
      ? yieldReactions.reduce((s, v) => s + v, 0) / yieldReactions.length
      : null

  return {
    vixSpikeSample: vixReactions.length,
    vixSpikeAvgNextDayMesPct: vixAvg == null ? null : Number(vixAvg.toFixed(2)),
    vixSpikeMedianNextDayMesPct: median(vixReactions) == null ? null : Number((median(vixReactions) as number).toFixed(2)),
    yieldSpikeSample: yieldReactions.length,
    yieldSpikeAvgNextDayMesPct: yieldAvg == null ? null : Number(yieldAvg.toFixed(2)),
    yieldSpikeMedianNextDayMesPct:
      median(yieldReactions) == null ? null : Number((median(yieldReactions) as number).toFixed(2)),
  }
}

function consecutiveCloses(candles: CandleData[], level: number, dir: 'above' | 'below'): number {
  let count = 0
  for (let i = candles.length - 1; i >= 0; i--) {
    const close = candles[i].close
    const match = dir === 'above' ? close > level : close < level
    if (!match) break
    count++
  }
  return count
}

function buildBreakout7000Context(mesCandles: CandleData[]): Breakout7000Context | null {
  const level = 7000
  if (mesCandles.length < 2) return null

  const last = mesCandles[mesCandles.length - 1]
  const prev = mesCandles[mesCandles.length - 2]
  const lastTwo: [number, number] = [prev.close, last.close]

  const closesAboveLevelLast2 = lastTwo.filter((v) => v > level).length
  const closesBelowLevelLast2 = lastTwo.filter((v) => v < level).length
  const consecutiveClosesAboveLevel = consecutiveCloses(mesCandles, level, 'above')
  const consecutiveClosesBelowLevel = consecutiveCloses(mesCandles, level, 'below')
  const twoCloseConfirmation = consecutiveClosesAboveLevel >= 2

  const touchedLevelToday = last.high >= level
  const distanceFromLevel = Number((last.close - level).toFixed(2))
  const nearLevel = Math.abs(distanceFromLevel) <= 20

  let status: Breakout7000Context['status']
  let signal = ''
  let tradePlan = ''

  if (twoCloseConfirmation) {
    status = 'CONFIRMED_BREAKOUT'
    signal = 'Two-close breakout confirmed: 2+ consecutive daily closes above 7,000.'
    tradePlan = 'Bias long above 7,000; invalidation is a daily close back below 7,000.'
  } else if (consecutiveClosesAboveLevel === 1) {
    status = 'UNCONFIRMED_BREAKOUT'
    signal = 'First close above 7,000 printed, but second close confirmation is missing.'
    tradePlan = 'Wait for a second consecutive daily close above 7,000 before treating as confirmed breakout.'
  } else if (touchedLevelToday && last.close < level) {
    status = 'REJECTED_AT_LEVEL'
    signal = 'Price tested 7,000 intraday and closed back below resistance.'
    tradePlan = 'Bias fade/reversion while below 7,000; invalidation is a confirmed two-close breakout above 7,000.'
  } else if (nearLevel) {
    status = 'TESTING_7000'
    signal = 'Price is testing the 7,000 pivot zone without confirmation.'
    tradePlan = 'Trade reaction at 7,000: breakout only after two closes above; otherwise treat as range resistance.'
  } else {
    status = 'BELOW_7000'
    signal = 'Price remains below the 7,000 resistance regime.'
    tradePlan = 'Respect 7,000 as resistance until a two-close daily confirmation above the level appears.'
  }

  return {
    level,
    status,
    latestClose: last.close,
    latestHigh: last.high,
    distanceFromLevel,
    lastTwoCloses: [Number(lastTwo[0].toFixed(2)), Number(lastTwo[1].toFixed(2))],
    closesAboveLevelLast2,
    closesBelowLevelLast2,
    consecutiveClosesAboveLevel,
    consecutiveClosesBelowLevel,
    twoCloseConfirmation,
    signal,
    tradePlan,
  }
}

// --- Narrative ---

export function buildIntermarketNarrative(
  regime: string,
  regimeFactors: string[],
  correlations: CorrelationResult[],
  goldCtx: { price: number; changePercent: number; signal: string } | null,
  oilCtx: { price: number; changePercent: number; signal: string } | null,
  yieldCtx: YieldContext | null,
  techLeaders: TechLeaderContext[],
  breakout7000: Breakout7000Context | null
): string {
  const parts: string[] = []
  parts.push(`Market regime: ${regime}.`)

  const vixCorr = correlations.find((c) => c.pair === 'MES↔VX')
  const yldCorr = correlations.find((c) => c.pair === 'MES↔US10Y')
  if (vixCorr) parts.push(`MES/VIX correlation ${vixCorr.value}.`)
  if (yldCorr) parts.push(`MES/10Y-yield correlation ${yldCorr.value}.`)

  if (yieldCtx) {
    parts.push(
      `US10Y ${yieldCtx.tenYearYield.toFixed(2)}% (${yieldCtx.tenYearChangeBp >= 0 ? '+' : ''}${yieldCtx.tenYearChangeBp.toFixed(1)} bp).`
    )
  }

  if (techLeaders.length > 0) {
    const up = techLeaders.filter((t) => t.dayChangePercent > 0).length
    parts.push(`AI/tech breadth ${up}/${techLeaders.length} advancers.`)
  }

  if (breakout7000) {
    parts.push(`SPX 7,000 detector: ${breakout7000.status.replaceAll('_', ' ')}.`)
  }

  if (goldCtx) {
    parts.push(
      `Gold ${goldCtx.changePercent >= 0 ? '+' : ''}${goldCtx.changePercent.toFixed(2)}%.`
    )
  }
  if (oilCtx) {
    parts.push(`Oil ${oilCtx.changePercent >= 0 ? '+' : ''}${oilCtx.changePercent.toFixed(2)}%.`)
  }

  if (regimeFactors.length > 0) {
    parts.push(regimeFactors.slice(0, 2).join(' '))
  }

  return parts.join(' ')
}

// --- Build full market context ---

export async function buildMarketContext(
  allCandles15m: Map<string, CandleData[]>,
  priceChanges: Map<string, number>
): Promise<MarketContext> {
  const correlations = computeCorrelations(allCandles15m)
  const { regime, factors: regimeFactors } = detectMarketRegime(priceChanges)

  const goldCandles = allCandles15m.get('GC')
  const oilCandles = allCandles15m.get('CL')
  const tenYearCandles = allCandles15m.get('US10Y')
  const vixCandles = allCandles15m.get('VX')
  const mesCandles = allCandles15m.get('MES') || []

  const goldContext = goldCandles ? buildCommodityContext(goldCandles) : null
  const oilContext = oilCandles ? buildCommodityContext(oilCandles) : null

  const [headlines, leaderRows, fedFundsRate] = await Promise.all([
    fetchMarketHeadlines(),
    fetchTechLeaderSnapshots().catch(() => []),
    fetchLatestFedFundsRate(),
  ])

  const techLeaders: TechLeaderContext[] = leaderRows.map((r) => ({
    symbol: r.symbol,
    name: r.name,
    price: r.price,
    dayChangePercent: Number(r.dayChangePercent.toFixed(2)),
    weekChangePercent: Number(r.weekChangePercent.toFixed(2)),
    signal:
      r.dayChangePercent > 1
        ? 'Strong risk-on tech leadership'
        : r.dayChangePercent < -1
          ? 'Risk-off tech pressure'
          : 'Neutral tech flow',
  }))

  if (techLeaders.length > 0) {
    const advancers = techLeaders.filter((t) => t.dayChangePercent > 0).length
    regimeFactors.push(`Top AI/tech breadth: ${advancers}/${techLeaders.length} up`)
  }

  const themeScores = computeThemeScores(headlines)
  const yieldContext = tenYearCandles ? buildYieldContext(tenYearCandles, fedFundsRate) : null
  const shockReactions = computeShockReactions(mesCandles, vixCandles, tenYearCandles)
  const breakout7000 = buildBreakout7000Context(mesCandles)

  const intermarketNarrative = buildIntermarketNarrative(
    regime,
    regimeFactors,
    correlations,
    goldContext,
    oilContext,
    yieldContext,
    techLeaders,
    breakout7000
  )

  return {
    regime,
    regimeFactors,
    correlations,
    headlines,
    goldContext,
    oilContext,
    yieldContext,
    techLeaders,
    themeScores,
    shockReactions,
    breakout7000,
    intermarketNarrative,
  }
}
