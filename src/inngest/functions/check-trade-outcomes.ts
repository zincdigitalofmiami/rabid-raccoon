/**
 * check-trade-outcomes — Scheduled outcome resolver for Warbird setups.
 *
 * Schedule: every 15 minutes, weekdays.
 * Calls the existing checkTradeOutcomes() from outcome-tracker.ts to resolve
 * pending Warbird setups (TP1 @ 4h, TP2 @ 8h).
 *
 * This replaces the fire-and-forget call that was in the API route.
 */

import { inngest } from '../client'
import { checkTradeOutcomes } from '../../lib/outcome-tracker'

export const checkOutcomes = inngest.createFunction(
  { id: 'check-trade-outcomes', retries: 2 },
  { cron: '*/15 * * * 1-5' }, // Every 15 min, Mon-Fri
  async ({ step }) => {
    const resolved = await step.run('resolve-outcomes', async () => {
      return checkTradeOutcomes()
    })

    return {
      ranAt: new Date().toISOString(),
      outcomesResolved: resolved,
    }
  },
)
