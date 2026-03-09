import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fromBhgSetup,
  toBhgSetup,
  type TriggerCandidate,
} from '@/lib/trigger-candidates'
import type { BhgSetup } from '@/lib/bhg-engine'

function baseBhgSetup(): BhgSetup {
  return {
    id: 'legacy-hook-1',
    direction: 'BULLISH',
    phase: 'TRIGGERED',
    fibLevel: 6024.5,
    fibRatio: 0.618,
    touchTime: 1_710_000_000,
    touchBarIndex: 10,
    touchPrice: 6024.5,
    hookTime: 1_710_000_900,
    hookBarIndex: 11,
    hookLow: 6023.75,
    hookHigh: 6026.25,
    hookClose: 6025.75,
    goTime: 1_710_001_800,
    goBarIndex: 12,
    goType: 'CLOSE',
    entry: 6026.25,
    stopLoss: 6023.5,
    tp1: 6032.5,
    tp2: 6038.75,
    createdAt: 1_710_000_000,
    expiryBars: 20,
  }
}

test('fromBhgSetup produces a neutral trigger candidate with preserved trade targets', () => {
  const candidate = fromBhgSetup(baseBhgSetup())

  assert.equal(candidate.sourceFamily, 'HOOK_REJECTION')
  assert.equal(candidate.triggerType, 'RETRACE_REJECTION')
  assert.equal(candidate.direction, 'BULLISH')
  assert.equal(candidate.phase, 'TRIGGERED')
  assert.equal(candidate.candidateTime, 1_710_001_800)
  assert.equal(candidate.referenceLevel, 6026.25)
  assert.equal(candidate.invalidationLevel, 6023.5)
  assert.equal(candidate.entry, 6026.25)
  assert.equal(candidate.tp1, 6032.5)
  assert.equal(candidate.tp2, 6038.75)
  assert.match(candidate.thesis, /retracement rejection/i)
})

test('toBhgSetup round-trips the fields the legacy recorder still needs', () => {
  const candidate: TriggerCandidate = fromBhgSetup(baseBhgSetup())
  const legacy = toBhgSetup(candidate)

  assert.deepEqual(legacy, baseBhgSetup())
})
