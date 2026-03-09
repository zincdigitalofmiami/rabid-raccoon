import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getEventDisplayLabel,
  getEventDisplayPhase,
  isActiveEventDisplayPhase,
} from '@/lib/event-display'

test('maps internal event phases to trader-facing display phases', () => {
  assert.equal(getEventDisplayPhase('CLEAR'), 'OPEN')
  assert.equal(getEventDisplayPhase('APPROACHING'), 'WATCH')
  assert.equal(getEventDisplayPhase('IMMINENT'), 'WATCH')
  assert.equal(getEventDisplayPhase('BLACKOUT'), 'LOCKOUT')
  assert.equal(getEventDisplayPhase('SHOCK'), 'REPRICE')
  assert.equal(getEventDisplayPhase('DIGESTION'), 'REPRICE')
  assert.equal(getEventDisplayPhase('SETTLED'), 'NORMAL')
  assert.equal(getEventDisplayPhase('UNKNOWN'), 'OPEN')
})

test('marks only watch, lockout, and reprice as active display phases', () => {
  assert.equal(isActiveEventDisplayPhase('CLEAR'), false)
  assert.equal(isActiveEventDisplayPhase('SETTLED'), false)
  assert.equal(isActiveEventDisplayPhase('APPROACHING'), true)
  assert.equal(isActiveEventDisplayPhase('BLACKOUT'), true)
  assert.equal(isActiveEventDisplayPhase('DIGESTION'), true)
})

test('builds trader-facing detail labels without internal ontology words', () => {
  assert.equal(
    getEventDisplayLabel({ phase: 'APPROACHING', eventName: 'CPI', minutesToEvent: 27.2 }),
    'CPI on deck in 27 min',
  )
  assert.equal(
    getEventDisplayLabel({ phase: 'BLACKOUT', eventName: 'FOMC', minutesToEvent: 2.1 }),
    'FOMC lockout active (3 min)',
  )
  assert.equal(
    getEventDisplayLabel({ phase: 'SHOCK', eventName: 'NFP', minutesSinceEvent: 1.4 }),
    'NFP repricing after release (1 min ago)',
  )
  assert.equal(
    getEventDisplayLabel({ phase: 'DIGESTION', eventName: 'Retail Sales', minutesSinceEvent: 18.8 }),
    'Retail Sales still stabilizing (19 min ago)',
  )
})
