export interface SymbolConfig {
  displayName: string
  shortName: string
  dataSource: 'databento' | 'fred'
  databentoSymbol?: string
  dataset?: string
  stypeIn?: string
  fredSymbol?: string
  tickSize: number
  description: string
}

export const SYMBOLS: Record<string, SymbolConfig> = {
  MES: {
    displayName: 'MES',
    shortName: 'Micro S&P',
    dataSource: 'databento',
    databentoSymbol: 'MES.c.0',
    dataset: 'GLBX.MDP3',
    stypeIn: 'continuous',
    tickSize: 0.25,
    description: 'Micro E-mini S&P 500',
  },
  NQ: {
    displayName: 'NQ',
    shortName: 'E-mini Nasdaq',
    dataSource: 'databento',
    databentoSymbol: 'NQ.c.0',
    dataset: 'GLBX.MDP3',
    stypeIn: 'continuous',
    tickSize: 0.25,
    description: 'E-mini Nasdaq-100',
  },
  YM: {
    displayName: 'YM',
    shortName: 'E-mini Dow',
    dataSource: 'databento',
    databentoSymbol: 'YM.c.0',
    dataset: 'GLBX.MDP3',
    stypeIn: 'continuous',
    tickSize: 1.0,
    description: 'E-mini Dow Jones',
  },
  RTY: {
    displayName: 'RTY',
    shortName: 'E-mini Russell',
    dataSource: 'databento',
    databentoSymbol: 'RTY.c.0',
    dataset: 'GLBX.MDP3',
    stypeIn: 'continuous',
    tickSize: 0.1,
    description: 'E-mini Russell 2000',
  },
  VX: {
    displayName: 'VIX',
    shortName: 'VIX Index',
    dataSource: 'fred',
    fredSymbol: 'VIXCLS',
    tickSize: 0.01,
    description: 'CBOE Volatility Index (via FRED)',
  },
  ZN: {
    displayName: 'ZN',
    shortName: '10Y T-Note',
    dataSource: 'databento',
    databentoSymbol: 'ZN.c.0',
    dataset: 'GLBX.MDP3',
    stypeIn: 'continuous',
    tickSize: 0.015625,
    description: '10-Year Treasury Note',
  },
  ZB: {
    displayName: 'ZB',
    shortName: '30Y T-Bond',
    dataSource: 'databento',
    databentoSymbol: 'ZB.c.0',
    dataset: 'GLBX.MDP3',
    stypeIn: 'continuous',
    tickSize: 0.03125,
    description: '30-Year Treasury Bond',
  },
  DX: {
    displayName: 'DXY',
    shortName: 'US Dollar',
    dataSource: 'fred',
    fredSymbol: 'DTWEXBGS',
    tickSize: 0.01,
    description: 'US Dollar Index (via FRED)',
  },
  GC: {
    displayName: 'GC',
    shortName: 'Gold',
    dataSource: 'databento',
    databentoSymbol: 'GC.c.0',
    dataset: 'GLBX.MDP3',
    stypeIn: 'continuous',
    tickSize: 0.1,
    description: 'Gold Futures (COMEX)',
  },
  CL: {
    displayName: 'CL',
    shortName: 'Crude Oil',
    dataSource: 'databento',
    databentoSymbol: 'CL.c.0',
    dataset: 'GLBX.MDP3',
    stypeIn: 'continuous',
    tickSize: 0.01,
    description: 'Crude Oil Futures (NYMEX)',
  },
}

export const SYMBOL_KEYS = Object.keys(SYMBOLS)
export const PRIMARY_SYMBOL = 'MES'
