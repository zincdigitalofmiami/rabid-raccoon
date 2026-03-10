import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateMes1mRowsTo15m,
  shouldUseDerivedMes15mRows,
} from '@/lib/mes-15m-derivation'

test('aggregateMes1mRowsTo15m aligns to 15m buckets and preserves OHLCV semantics', () => {
  const rows = [
    {
      eventTime: new Date('2026-03-09T14:14:00Z'),
      open: 6004,
      high: 6006,
      low: 6003,
      close: 6005,
      volume: 8,
    },
    {
      eventTime: new Date('2026-03-09T14:01:00Z'),
      open: 6000,
      high: 6005,
      low: 5999,
      close: 6004,
      volume: 10,
    },
    {
      eventTime: new Date('2026-03-09T14:16:00Z'),
      open: 6006,
      high: 6007,
      low: 6004,
      close: 6005,
      volume: 7,
    },
  ]

  const bars = aggregateMes1mRowsTo15m(rows)

  assert.equal(bars.length, 2)
  assert.equal(bars[0].eventTime.toISOString(), '2026-03-09T14:00:00.000Z')
  assert.equal(bars[0].open, 6000)
  assert.equal(bars[0].high, 6006)
  assert.equal(bars[0].low, 5999)
  assert.equal(bars[0].close, 6005)
  assert.equal(bars[0].volume, 18)
  assert.equal(bars[1].eventTime.toISOString(), '2026-03-09T14:15:00.000Z')
  assert.equal(bars[1].open, 6006)
  assert.equal(bars[1].high, 6007)
  assert.equal(bars[1].low, 6004)
  assert.equal(bars[1].close, 6005)
  assert.equal(bars[1].volume, 7)
})

test('aggregateMes1mRowsTo15m drops pathological 1m rows during sanitation', () => {
  const rows = [
    {
      eventTime: new Date('2026-03-09T14:00:00Z'),
      open: 5000,
      high: 5002,
      low: 4998,
      close: 5001,
      volume: 10,
    },
    {
      // Invalid 1m range: >8% from open, should be removed.
      eventTime: new Date('2026-03-09T14:01:00Z'),
      open: 5001,
      high: 5450,
      low: 4700,
      close: 5000,
      volume: 999,
    },
    {
      eventTime: new Date('2026-03-09T14:02:00Z'),
      open: 5001,
      high: 5003,
      low: 5000,
      close: 5002,
      volume: 9,
    },
  ]

  const bars = aggregateMes1mRowsTo15m(rows)
  assert.equal(bars.length, 1)
  assert.equal(bars[0].open, 5000)
  assert.equal(bars[0].high, 5003)
  assert.equal(bars[0].low, 4998)
  assert.equal(bars[0].close, 5002)
  assert.equal(bars[0].volume, 19)
})

test('shouldUseDerivedMes15mRows requires near-full window for wide-context consumers', () => {
  assert.equal(
    shouldUseDerivedMes15mRows({
      derivedCount: 150,
      requestedLimit: 200,
      minimumDerivedBars: 195,
    }),
    false,
  )

  assert.equal(
    shouldUseDerivedMes15mRows({
      derivedCount: 195,
      requestedLimit: 200,
      minimumDerivedBars: 195,
    }),
    true,
  )
})
