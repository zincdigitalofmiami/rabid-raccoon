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
