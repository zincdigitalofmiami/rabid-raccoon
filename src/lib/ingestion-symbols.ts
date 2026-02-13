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

const SYMBOL_CODES = [
  'ES',
  'MES',
  'NQ',
  'MNQ',
  'YM',
  'MYM',
  'RTY',
  'M2K',
  'EMD',
  'NIY',
  'NKD',
  'XAE',
  'XAF',
  'XAV',
  'XAI',
  'XAB',
  'XAR',
  'XAK',
  'XAU',
  'XAY',
  'XAP',
  'XAZ',
  'SXB',
  'SXI',
  'SXT',
  'SXO',
  'SXR',
  'SOX',
  'BIO',
  'RS1',
  'RSG',
  'RSV',
] as const

const META: Record<string, { shortName: string; description: string; tickSize: number }> = {
  ES: { shortName: 'E-mini S&P', description: 'E-mini S&P 500 Futures', tickSize: 0.25 },
  MES: { shortName: 'Micro S&P', description: 'Micro E-mini S&P 500 Futures', tickSize: 0.25 },
  NQ: { shortName: 'E-mini Nasdaq', description: 'E-mini Nasdaq-100 Futures', tickSize: 0.25 },
  MNQ: { shortName: 'Micro Nasdaq', description: 'Micro E-mini Nasdaq-100 Futures', tickSize: 0.25 },
  YM: { shortName: 'E-mini Dow', description: 'E-mini Dow Jones Futures', tickSize: 1.0 },
  MYM: { shortName: 'Micro Dow', description: 'Micro E-mini Dow Jones Futures', tickSize: 1.0 },
  RTY: { shortName: 'E-mini Russell', description: 'E-mini Russell 2000 Futures', tickSize: 0.1 },
  M2K: { shortName: 'Micro Russell', description: 'Micro E-mini Russell 2000 Futures', tickSize: 0.1 },
  EMD: { shortName: 'S&P Midcap', description: 'S&P MidCap 400 Futures', tickSize: 0.1 },
  NIY: { shortName: 'Nikkei Yen', description: 'Nikkei 225 Yen-Denominated Futures', tickSize: 5.0 },
  NKD: { shortName: 'Nikkei JPY', description: 'Nikkei 225 JPY Futures', tickSize: 5.0 },
  XAE: { shortName: 'XA E', description: 'XA E Futures', tickSize: 0.01 },
  XAF: { shortName: 'XA F', description: 'XA F Futures', tickSize: 0.01 },
  XAV: { shortName: 'XA V', description: 'XA V Futures', tickSize: 0.01 },
  XAI: { shortName: 'XA I', description: 'XA I Futures', tickSize: 0.01 },
  XAB: { shortName: 'XA B', description: 'XA B Futures', tickSize: 0.01 },
  XAR: { shortName: 'XA R', description: 'XA R Futures', tickSize: 0.01 },
  XAK: { shortName: 'XA K', description: 'XA K Futures', tickSize: 0.01 },
  XAU: { shortName: 'XA U', description: 'XA U Futures', tickSize: 0.01 },
  XAY: { shortName: 'XA Y', description: 'XA Y Futures', tickSize: 0.01 },
  XAP: { shortName: 'XA P', description: 'XA P Futures', tickSize: 0.01 },
  XAZ: { shortName: 'XA Z', description: 'XA Z Futures', tickSize: 0.01 },
  SXB: { shortName: 'S&P Financials', description: 'S&P 500 Financials Sector Futures', tickSize: 0.05 },
  SXI: { shortName: 'S&P Industrials', description: 'S&P 500 Industrials Sector Futures', tickSize: 0.05 },
  SXT: { shortName: 'SX T', description: 'SX T Futures', tickSize: 0.01 },
  SXO: { shortName: 'S&P Growth', description: 'S&P 500 Growth Futures', tickSize: 0.05 },
  SXR: { shortName: 'S&P Real Estate', description: 'S&P 500 Real Estate Sector Futures', tickSize: 0.05 },
  SOX: { shortName: 'Semiconductor', description: 'PHLX Semiconductor Sector Futures', tickSize: 0.05 },
  BIO: { shortName: 'Biotech', description: 'Biotechnology Index Futures', tickSize: 0.05 },
  RS1: { shortName: 'RS1', description: 'RS1 Futures', tickSize: 0.01 },
  RSG: { shortName: 'RSG', description: 'RSG Futures', tickSize: 0.01 },
  RSV: { shortName: 'RSV', description: 'RSV Futures', tickSize: 0.01 },
}

export const INGESTION_SYMBOLS: IngestionSymbol[] = SYMBOL_CODES.map((code) => {
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
