import test from 'node:test'
import assert from 'node:assert/strict'
import { computeRisk } from '../src/lib/risk-engine'

test('computeRisk charges at least one tick for any non-zero stop distance', () => {
  const risk = computeRisk(100, 99.9, 100.5, {
    accountSize: 10_000,
    riskPercent: 0.01,
    tickValue: 1.25,
    tickSize: 0.25,
  })

  assert.equal(risk.stopDistance, 0.1)
  assert.equal(risk.stopTicks, 1)
  assert.equal(risk.dollarRisk, 1.25)
})
