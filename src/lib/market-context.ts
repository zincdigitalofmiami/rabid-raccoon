/**
 * Market Context Engine
 *
 * Cross-asset correlations, market regime detection, and real-time
 * news headlines. This is what turns indicator dumps into REAL analysis.
 */

import { CandleData } from './types'

// --- Types ---

export interface CorrelationResult {
  pair: string
  value: number
  interpretation: string
}

export interface MarketContext {
  regime: 'RISK-ON' | 'RISK-OFF' | 'MIXED'
  regimeFactors: string[]
  correlations: CorrelationResult[]
  headlines: string[]
  goldContext: { price: number; change: number; changePercent: number; signal: string } | null
  oilContext: { price: number; change: number; changePercent: number; signal: string } | null
  intermarketNarrative: string
}

// --- Correlation computation ---

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
  const aa = a.slice(-n), bb = b.slice(-n)
  const meanA = aa.reduce((s, v) => s + v, 0) / n
  const meanB = bb.reduce((s, v) => s + v, 0) / n
  let cov = 0, varA = 0, varB = 0
  for (let i = 0; i < n; i++) {
    const da = aa[i] - meanA, db = bb[i] - meanB
    cov += da * db
    varA += da * da
    varB += db * db
  }
  const denom = Math.sqrt(varA * varB)
  return denom === 0 ? 0 : cov / denom
}

function interpretCorrelation(symbol: string, corr: number): string {
  const abs = Math.abs(corr)
  const strength = abs > 0.7 ? 'Strong' : abs > 0.4 ? 'Moderate' : 'Weak'
  const dir = corr > 0 ? 'positive' : 'negative'

  // Context-specific interpretations
  if (symbol === 'NQ') {
    if (corr > 0.7) return `${strength} ${dir} — tech aligned with S&P, risk appetite confirmed`
    if (corr > 0.4) return `Moderate alignment — watch for NQ divergence as leadership signal`
    return `Weak — NQ and MES decoupling, sector rotation underway`
  }
  if (symbol === 'VX') {
    if (corr < -0.5) return `${strength} inverse — VIX confirming equity direction (normal)`
    if (corr > 0) return `ABNORMAL: VIX rising WITH equities — stress building, hedging activity`
    return `Weak inverse — VIX not fully pricing the move`
  }
  if (symbol === 'GC') {
    if (corr < -0.3) return `Gold inverse to equities — classic risk-on, no safe-haven demand`
    if (corr > 0.3) return `Gold and equities BOTH bid — inflation hedge or uncertainty bid`
    return `Gold independent — commodity-specific drivers dominating`
  }
  if (symbol === 'CL') {
    if (corr > 0.4) return `Oil positive with equities — demand-driven growth signal`
    if (corr < -0.3) return `Oil inverse — stagflation risk or supply shock`
    return `Oil decoupled — supply/geopolitics dominating`
  }
  if (symbol === 'ZN' || symbol === 'ZB') {
    if (corr < -0.4) return `Bonds inverse — money rotating from bonds to equities`
    if (corr > 0.4) return `Bonds AND equities bid — flight to quality or rate cut bets`
    return `Bond-equity correlation weak — macro uncertainty`
  }
  if (symbol === 'DX') {
    if (corr < -0.3) return `Dollar inverse — weak dollar bullish for risk assets`
    if (corr > 0.3) return `Dollar positive with equities — unusual, check safe-haven flows`
    return `Dollar independent of equities`
  }

  return `${strength} ${dir} correlation`
}

export function computeCorrelations(
  symbolCandles: Map<string, CandleData[]>
): CorrelationResult[] {
  const mesCandles = symbolCandles.get('MES')
  if (!mesCandles || mesCandles.length < 20) return []

  const mesCloses = mesCandles.map(c => c.close)
  const mesRet = returns(mesCloses)
  const results: CorrelationResult[] = []

  for (const [symbol, candles] of symbolCandles.entries()) {
    if (symbol === 'MES') continue
    const closes = candles.map(c => c.close)
    const ret = returns(closes)
    const corr = pearsonCorrelation(mesRet, ret)
    results.push({
      pair: `MES↔${symbol}`,
      value: Number(corr.toFixed(3)),
      interpretation: interpretCorrelation(symbol, corr),
    })
  }

  return results.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
}

// --- Market regime detection ---

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

  // Equities
  if (mes > 0.05) { riskOnScore += 2; factors.push(`Equities bid: MES +${mes.toFixed(2)}%`) }
  else if (mes < -0.05) { riskOnScore -= 2; factors.push(`Equities offered: MES ${mes.toFixed(2)}%`) }
  else { factors.push(`Equities flat: MES ${mes.toFixed(2)}%`) }

  // Tech leadership
  if (Math.abs(nq) > 0.01 && Math.abs(mes) > 0.01) {
    if (nq > mes + 0.1) { riskOnScore += 1; factors.push(`Tech leading: NQ outperforming MES by ${(nq - mes).toFixed(2)}%`) }
    else if (nq < mes - 0.1) { riskOnScore -= 1; factors.push(`Tech lagging: NQ underperforming MES by ${(mes - nq).toFixed(2)}%`) }
  }

  // VIX (inverse)
  if (vix < -1) { riskOnScore += 1; factors.push(`Vol compression: VIX ${vix.toFixed(2)}% — complacency`) }
  else if (vix > 1) { riskOnScore -= 2; factors.push(`Vol expansion: VIX +${vix.toFixed(2)}% — fear rising`) }
  else if (vix !== 0) { factors.push(`VIX stable (${vix.toFixed(2)}%)`) }

  // Bonds
  if (zn < -0.05) { riskOnScore += 1; factors.push(`Bonds selling off: ZN ${zn.toFixed(2)}% — equity rotation`) }
  else if (zn > 0.05) { riskOnScore -= 1; factors.push(`Bonds bid: ZN +${zn.toFixed(2)}% — safety demand`) }

  // Gold
  if (gc < -0.1) { riskOnScore += 1; factors.push(`Gold declining ${gc.toFixed(2)}% — no safe-haven demand`) }
  else if (gc > 0.3) { riskOnScore -= 1; factors.push(`Gold bid +${gc.toFixed(2)}% — safe-haven buying`) }
  else if (gc !== 0) { factors.push(`Gold steady (${gc.toFixed(2)}%)`) }

  // Oil
  if (cl > 0.3) { factors.push(`Oil up +${cl.toFixed(2)}% — demand signal or supply concern`) }
  else if (cl < -0.3) { factors.push(`Oil down ${cl.toFixed(2)}% — demand weakness`) }
  else if (cl !== 0) { factors.push(`Oil flat (${cl.toFixed(2)}%)`) }

  // Dollar
  if (dx > 0.1) { riskOnScore -= 1; factors.push(`Dollar strengthening +${dx.toFixed(2)}% — risk-off flows`) }
  else if (dx < -0.1) { riskOnScore += 1; factors.push(`Dollar weakening ${dx.toFixed(2)}% — risk appetite`) }

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
  if (changePercent > 0.5) signal = 'Bid — potential inflation hedge / safe-haven'
  else if (changePercent < -0.5) signal = 'Offered — risk-on / no fear'
  else signal = 'Rangebound — no strong directional signal'
  return { price, change, changePercent, signal }
}

// --- Intermarket narrative ---

export function buildIntermarketNarrative(
  regime: string,
  regimeFactors: string[],
  correlations: CorrelationResult[],
  goldCtx: { price: number; changePercent: number; signal: string } | null,
  oilCtx: { price: number; changePercent: number; signal: string } | null
): string {
  const parts: string[] = []

  parts.push(`Market regime: ${regime}.`)

  // Strongest correlations
  const strong = correlations.filter(c => Math.abs(c.value) > 0.5)
  if (strong.length > 0) {
    parts.push(`Key correlations: ${strong.map(c => `${c.pair}=${c.value}`).join(', ')}.`)
  }

  // Gold/Oil context
  if (goldCtx) parts.push(`Gold @ ${goldCtx.price.toFixed(2)} (${goldCtx.changePercent >= 0 ? '+' : ''}${goldCtx.changePercent.toFixed(2)}%) — ${goldCtx.signal}.`)
  if (oilCtx) parts.push(`Oil @ ${oilCtx.price.toFixed(2)} (${oilCtx.changePercent >= 0 ? '+' : ''}${oilCtx.changePercent.toFixed(2)}%) — ${oilCtx.signal}.`)

  return parts.join(' ')
}

// --- Real-time market headlines ---

export async function fetchMarketHeadlines(): Promise<string[]> {
  try {
    // Fetch from Google News RSS — free, no API key needed
    const queries = [
      'stock market futures today',
      'S&P 500 market news',
      'Trump tariffs trade policy',
    ]

    const allHeadlines: string[] = []

    for (const q of queries) {
      try {
        const res = await fetch(
          `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`,
          {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RabidRaccoon/2.0)' },
            signal: AbortSignal.timeout(4000),
          }
        )
        if (!res.ok) continue
        const xml = await res.text()

        // Extract titles from <item><title> tags
        const itemTitles = [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)]
          .map(m => m[1]?.trim())
          .filter((t): t is string => !!t && t.length > 10)

        allHeadlines.push(...itemTitles)
      } catch {
        // Individual query failure — continue with others
      }
    }

    // Deduplicate and limit
    return [...new Set(allHeadlines)].slice(0, 15)
  } catch {
    return []
  }
}

// --- Build full market context ---

export async function buildMarketContext(
  allCandles15m: Map<string, CandleData[]>,
  priceChanges: Map<string, number>
): Promise<MarketContext> {
  // Correlations from 15m candles
  const correlations = computeCorrelations(allCandles15m)

  // Market regime from price changes
  const { regime, factors: regimeFactors } = detectMarketRegime(priceChanges)

  // Commodity context
  const goldCandles = allCandles15m.get('GC')
  const oilCandles = allCandles15m.get('CL')
  const goldContext = goldCandles ? buildCommodityContext(goldCandles) : null
  const oilContext = oilCandles ? buildCommodityContext(oilCandles) : null

  // Real-time headlines
  const headlines = await fetchMarketHeadlines()

  // Intermarket narrative
  const intermarketNarrative = buildIntermarketNarrative(
    regime, regimeFactors, correlations, goldContext, oilContext
  )

  return {
    regime,
    regimeFactors,
    correlations,
    headlines,
    goldContext,
    oilContext,
    intermarketNarrative,
  }
}
