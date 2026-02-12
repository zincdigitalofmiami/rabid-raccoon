export type ForecastTargetKind = 'ENTRY' | 'TP' | 'SL'

export interface ForecastTarget {
  id: string
  kind: ForecastTargetKind
  label: string               // "TP1 5962.50 | Hit 34% | MAE +/-0.85 | FIB-0.618"
  startTime: number           // unix seconds — last candle time
  endTime: number             // unix seconds — future projection end
  price: number               // center of zone (snapped or raw OOF)
  bandHalfWidth: number       // MAE half-width (zone = price +/- bandHalfWidth). 0 = dashed line only
  tags: string[]              // provenance: ['OOF'], ['OOF','FIB-0.618'], etc.
  color: string               // from TV palette
  mcProbTouch?: number        // MC probability for label only (0-1)
  mcRuns?: number             // MC sample count for label
}
