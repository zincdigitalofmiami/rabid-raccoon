/**
 * Snap-Blend Target Mapping
 *
 * Maps MeasuredMove (AB=CD) + FibResult into ForecastTarget[] for the chart primitive.
 *
 * Rule: OOF (core model target) is primary. If the .618 fib extension aligns
 * within snapMult * MAE tolerance, snap to the fib level and tag with provenance.
 */

import { MeasuredMove, FibResult } from '../types'
import { ForecastTarget, ForecastTargetKind } from './types'
import { fibExtension, roundToTick } from '../ta/fibonacci'
import TV from '../colors'

function buildLabel(
  kind: ForecastTargetKind,
  price: number,
  tags: string[],
  mcProbTouch?: number,
  mae?: number
): string {
  const parts: string[] = [`${kind} ${price.toFixed(2)}`]
  if (mcProbTouch != null) parts.push(`Hit ${Math.round(mcProbTouch * 100)}%`)
  if (mae != null) parts.push(`MAE +/-${mae.toFixed(2)}`)
  const fibTag = tags.find((t) => t.startsWith('FIB-'))
  if (fibTag) parts.push(fibTag)
  return parts.join(' | ')
}

function kindColor(kind: ForecastTargetKind): string {
  switch (kind) {
    case 'TP':
      return TV.bull.primary
    case 'SL':
      return TV.bear.primary
    case 'ENTRY':
      return TV.blue.primary
  }
}

export function mapMeasuredMoveAndCoreToTargets(
  move: MeasuredMove,
  fib: FibResult | null,
  lastCandleTime: number,
  futureEndTime: number,
  tick: number = 0.25,
  snapMult: number = 1.5
): ForecastTarget[] {
  const targets: ForecastTarget[] = []
  const dir = move.direction

  // Compute fib .618 extension from ABC points
  let fib618Target: number | null = null
  if (fib) {
    fib618Target = fibExtension(
      move.pointA.price,
      move.pointB.price,
      move.pointC.price,
      0.618
    )
  }

  // --- TP: snap-blend against fib .618 ---
  let tpPrice = move.target
  const tpTags: string[] = ['OOF']
  const snapTolerance = roundToTick(Math.max(tick, snapMult * tick), tick)

  if (fib618Target != null) {
    const delta = Math.abs(tpPrice - fib618Target)
    if (delta <= snapTolerance) {
      tpPrice = fib618Target
      tpTags.push('FIB-0.618')
    }
  }
  tpPrice = roundToTick(tpPrice, tick)

  targets.push({
    id: `${dir}-TP-${move.pointC.barIndex}`,
    kind: 'TP',
    label: buildLabel('TP', tpPrice, tpTags),
    startTime: lastCandleTime,
    endTime: futureEndTime,
    price: tpPrice,
    bandHalfWidth: 0,
    tags: tpTags,
    color: kindColor('TP'),
    mcProbTouch: undefined,
    mcRuns: undefined,
  })

  // --- ENTRY: at .500 retrace (point C area) ---
  const entryPrice = roundToTick(move.entry, tick)
  const entryTags: string[] = ['OOF']

  targets.push({
    id: `${dir}-ENTRY-${move.pointC.barIndex}`,
    kind: 'ENTRY',
    label: buildLabel('ENTRY', entryPrice, entryTags),
    startTime: lastCandleTime,
    endTime: futureEndTime,
    price: entryPrice,
    bandHalfWidth: 0, // dashed line, no band
    tags: entryTags,
    color: kindColor('ENTRY'),
  })

  // --- SL: beyond .618 retrace ---
  const slPrice = roundToTick(move.stop, tick)
  const slTags: string[] = ['OOF']

  targets.push({
    id: `${dir}-SL-${move.pointC.barIndex}`,
    kind: 'SL',
    label: buildLabel('SL', slPrice, slTags),
    startTime: lastCandleTime,
    endTime: futureEndTime,
    price: slPrice,
    bandHalfWidth: 0, // dashed line, no band
    tags: slTags,
    color: kindColor('SL'),
  })

  return targets
}
