export interface IngestionSymbol {
  code: string
  displayName: string
  shortName: string
  description: string
  databentoSymbol: string
  dataset: string
  tickSize: number
}

const GLBX = 'GLBX.MDP3'

const ACTIVE_SYMBOLS = [
  // KEEP (6) — existing
  'ES',
  'MES',
  'NQ',
  'YM',
  'RTY',
  'SOX',
  // ADD (6) — new cross-asset correlation symbols
  'ZN',  // 10Y Treasury Note
  'ZB',  // 30Y Bond
  'ZF',  // 5Y Note
  'CL',  // Crude Oil
  'GC',  // Gold
  'SI',  // Silver
] as const

const META: Record<string, { shortName: string; description: string; tickSize: number }> = {
  ES: { shortName: 'E-mini S&P', description: 'E-mini S&P 500 Futures', tickSize: 0.25 },
  MES: { shortName: 'Micro S&P', description: 'Micro E-mini S&P 500 Futures', tickSize: 0.25 },
  NQ: { shortName: 'E-mini Nasdaq', description: 'E-mini Nasdaq-100 Futures', tickSize: 0.25 },
  YM: { shortName: 'E-mini Dow', description: 'E-mini Dow Jones Futures', tickSize: 1.0 },
  RTY: { shortName: 'E-mini Russell', description: 'E-mini Russell 2000 Futures', tickSize: 0.1 },
  SOX: { shortName: 'Semiconductor', description: 'PHLX Semiconductor Index Futures', tickSize: 0.1 },
  ZN: { shortName: '10Y Note', description: '10-Year Treasury Note Futures', tickSize: 0.015625 },
  ZB: { shortName: '30Y Bond', description: '30-Year Treasury Bond Futures', tickSize: 0.03125 },
  ZF: { shortName: '5Y Note', description: '5-Year Treasury Note Futures', tickSize: 0.0078125 },
  CL: { shortName: 'Crude Oil', description: 'WTI Crude Oil Futures', tickSize: 0.01 },
  GC: { shortName: 'Gold', description: 'Gold Futures', tickSize: 0.1 },
  SI: { shortName: 'Silver', description: 'Silver Futures', tickSize: 0.005 },
}

export const INGESTION_SYMBOLS: IngestionSymbol[] = ACTIVE_SYMBOLS.map((code) => {
  const meta = META[code]
  return {
    code,
    displayName: code,
    shortName: meta.shortName,
    description: meta.description,
    databentoSymbol: `${code}.c.0`,
    dataset: GLBX,
    tickSize: meta.tickSize,
  }
})

export const INGESTION_SYMBOL_CODES = INGESTION_SYMBOLS.map((s) => s.code)
