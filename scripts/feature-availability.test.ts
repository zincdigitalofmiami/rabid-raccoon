import test from 'node:test'
import assert from 'node:assert/strict'
import {
  asofLookupByDateKey,
  asofLookupLagged,
  conservativeLagDaysForFrequency,
  dateKeyUtc,
  laggedWindowKeys,
  shiftUtcDays,
} from './feature-availability'

test('asofLookupByDateKey returns most recent value at or before target date', () => {
  const lookup = new Map<string, number>([
    ['2026-02-10', 10],
    ['2026-02-11', 20],
    ['2026-02-13', 30],
  ])
  const keys = [...lookup.keys()]

  assert.equal(asofLookupByDateKey(lookup, keys, '2026-02-09'), null)
  assert.equal(asofLookupByDateKey(lookup, keys, '2026-02-10'), 10)
  assert.equal(asofLookupByDateKey(lookup, keys, '2026-02-12'), 20)
  assert.equal(asofLookupByDateKey(lookup, keys, '2026-02-14'), 30)
})

test('asofLookupLagged enforces availability lag', () => {
  const lookup = new Map<string, number>([
    ['2026-02-10', 10],
    ['2026-02-11', 20],
    ['2026-02-12', 30],
  ])
  const keys = [...lookup.keys()]
  const ts = new Date('2026-02-12T18:00:00Z')

  assert.equal(asofLookupLagged(lookup, keys, ts, 0), 30)
  assert.equal(asofLookupLagged(lookup, keys, ts, 1), 20)
  assert.equal(asofLookupLagged(lookup, keys, ts, 2), 10)
})

test('conservative lag policy is strict by frequency', () => {
  assert.equal(conservativeLagDaysForFrequency('daily'), 1)
  assert.equal(conservativeLagDaysForFrequency('weekly'), 8)
  assert.equal(conservativeLagDaysForFrequency('monthly'), 35)
  assert.equal(conservativeLagDaysForFrequency('quarterly'), 100)
})

test('laggedWindowKeys shifts both start and end away from same-day leakage', () => {
  const ts = new Date('2026-02-16T14:30:00Z')
  const { startKey, endKey } = laggedWindowKeys(ts, 1, 7)

  assert.equal(endKey, '2026-02-15')
  assert.equal(startKey, '2026-02-08')

  const shifted = shiftUtcDays(ts, -1)
  assert.equal(dateKeyUtc(shifted), '2026-02-15')
})
