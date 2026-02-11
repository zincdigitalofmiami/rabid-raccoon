export interface SwingPoint {
  price: number
  barIndex: number
  isHigh: boolean
  time: number
}

export interface FibLevel {
  ratio: number
  price: number
  label: string
  color: string
  isExtension: boolean
}

export interface FibResult {
  levels: FibLevel[]
  anchorHigh: number
  anchorLow: number
  isBullish: boolean
  anchorHighBarIndex: number
  anchorLowBarIndex: number
}

export interface CandleData {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export interface DatabentoOhlcvRecord {
  hd: {
    ts_event: string
    rtype: number
    publisher_id: number
    instrument_id: number
  }
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MarketDataResponse {
  symbol: string
  candles: CandleData[]
  fibLevels: FibLevel[] | null
  swingPoints: SwingPoint[]
  latestPrice: number | null
  percentChange: number | null
  meta: {
    lastUpdated: string
    candleCount: number
    dataset: string
  }
}

// --- V2 Types: Measured Move, Signals, Forecast ---

export interface MeasuredMove {
  direction: 'BULLISH' | 'BEARISH'
  pointA: SwingPoint
  pointB: SwingPoint
  pointC: SwingPoint
  projectedD: number
  retracementRatio: number
  entry: number
  stop: number
  target: number
  quality: number
  status: 'FORMING' | 'ACTIVE' | 'TARGET_HIT' | 'STOPPED_OUT'
}

export interface TradeSignal {
  symbol: string
  direction: 'BULLISH' | 'BEARISH'
  confidence: number
  confluenceFactors: string[]
  entry?: number
  stop?: number
  target?: number
  measuredMove?: MeasuredMove
}

export interface CompositeSignal {
  direction: 'BULLISH' | 'BEARISH'
  confidence: number
  primarySignal: TradeSignal
  symbolSignals: TradeSignal[]
  confluenceSummary: string[]
  timestamp: string
}

export interface MarketSummary {
  symbol: string
  displayName: string
  price: number
  change: number
  changePercent: number
  sparklineData: number[]
  direction: 'BULLISH' | 'BEARISH'
  signal: TradeSignal
}

export interface ForecastResponse {
  window: 'morning' | 'premarket' | 'midday' | 'afterhours'
  direction: 'BULLISH' | 'BEARISH'
  confidence: number
  analysis: string
  symbolForecasts: SymbolForecast[]
  keyLevels: { support: number[]; resistance: number[] }
  measuredMoves: MeasuredMove[]
  intermarketNotes: string[]
  generatedAt: string
}

export interface SymbolForecast {
  symbol: string
  direction: 'BULLISH' | 'BEARISH'
  confidence: number
}
