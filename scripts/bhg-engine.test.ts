import test from 'node:test'
import assert from 'node:assert/strict'
import { computeTargets, detectTouch, type BhgSetup } from '../src/lib/bhg-engine'
import type { FibResult, MeasuredMove } from '../src/lib/types'

function makeFibResult(isBullish: boolean): FibResult {
  const anchorHigh = 7000
  const anchorLow = 6900
  const range = anchorHigh - anchorLow
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618]

  return {
    levels: ratios.map((ratio) => ({
      ratio,
      price: isBullish ? anchorLow + range * ratio : anchorHigh - range * ratio,
      label: String(ratio),
      color: '#fff',
      isExtension: ratio > 1,
    })),
    anchorHigh,
    anchorLow,
    isBullish,
    anchorHighBarIndex: 10,
    anchorLowBarIndex: 20,
  }
}

function baseGoSetup(direction: 'BULLISH' | 'BEARISH'): BhgSetup {
  return {
    id: `${direction}-0.5-1`,
    direction,
    phase: 'GO_FIRED',
    fibLevel: 6950,
    fibRatio: 0.5,
    hookTime: 1,
    hookBarIndex: 1,
    hookLow: 6940,
    hookHigh: 6960,
    hookClose: 6950,
    goTime: 2,
    goBarIndex: 2,
    goType: 'BREAK',
    createdAt: 1,
    expiryBars: 20,
  }
}

test('detectTouch requires the candle range to actually tag the fib level', () => {
  const notTagged = detectTouch(
    { time: 1, open: 6958, high: 6960, low: 6950, close: 6955, volume: 1 },
    0,
    6926,
    0.5,
    true
  )
  assert.equal(notTagged, null)

  const tagged = detectTouch(
    { time: 1, open: 6928, high: 6931, low: 6925, close: 6929, volume: 1 },
    0,
    6926,
    0.5,
    false
  )
  assert.ok(tagged)
})

test('computeTargets keeps bearish geometry valid even when fib orientation is bullish', () => {
  const fib = makeFibResult(true)
  const setup = baseGoSetup('BEARISH')
  const result = computeTargets(setup, fib, [])

  assert.ok(result.entry != null)
  assert.ok(result.stopLoss != null && result.stopLoss > result.entry!)
  assert.ok(result.tp1 != null && result.tp1 < result.entry!)
  assert.ok(result.tp2 != null && result.tp2 < result.tp1!)
})

test('computeTargets ignores measured-move targets that violate direction', () => {
  const fib = makeFibResult(true)
  const setup = baseGoSetup('BEARISH')
  const badMove: MeasuredMove = {
    direction: 'BEARISH',
    pointA: { price: 7000, barIndex: 1, isHigh: true, time: 1 },
    pointB: { price: 6900, barIndex: 2, isHigh: false, time: 2 },
    pointC: { price: 6960, barIndex: 3, isHigh: true, time: 3 },
    projectedD: 7050, // wrong side for bearish
    retracementRatio: 0.6,
    entry: 6960,
    stop: 7070,
    target: 7050,
    target1236: 7074,
    quality: 75,
    status: 'ACTIVE',
  }

  const result = computeTargets(setup, fib, [badMove])
  assert.ok(result.tp1 != null && result.tp1 < result.entry!)
})

test('computeTargets keeps bullish geometry valid even when fib orientation is bearish', () => {
  const fib = makeFibResult(false)
  const setup = baseGoSetup('BULLISH')
  const result = computeTargets(setup, fib, [])

  assert.ok(result.entry != null)
  assert.ok(result.stopLoss != null && result.stopLoss < result.entry!)
  assert.ok(result.tp1 != null && result.tp1 > result.entry!)
  assert.ok(result.tp2 != null && result.tp2 > result.tp1!)
})
