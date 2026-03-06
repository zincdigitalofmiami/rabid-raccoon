/**
 * trade-recorder.ts — Persist scored trades to the database for training.
 *
 * Uses a direct pg connection (DIRECT_URL) to bypass Prisma Accelerate
 * schema caching. The scored_trades table is created by
 * scripts/create-scored-trades.ts.
 */

import type { ScoredTrade } from '@/app/api/trades/upcoming/route'
import type { EventContext } from '@/lib/event-awareness'
import { getDirectPool } from './direct-pool'
import { canonicalSetupId } from './setup-id'

// ─────────────────────────────────────────────
// Setup hash (dedup key)
// ─────────────────────────────────────────────

function makeSetupHash(trade: ScoredTrade): string {
  return canonicalSetupId(trade.setup)
}

// ─────────────────────────────────────────────
// Record trades
// ─────────────────────────────────────────────

const INSERT_SQL = `
  INSERT INTO scored_trades (
    "setupHash", direction, "fibRatio", "goType",
    "entryPrice", "stopLoss", tp1, tp2, "currentPrice",
    "compositeScore", grade, "pTp1", "pTp2", "mlSource",
    rr, "dollarRisk",
    "eventPhase", "confidenceAdj",
    rationale, "reasoningSource", "adjustedPTp1", "adjustedPTp2",
    features, "scoreBreakdown", flags,
    "scoredAt", "createdAt", "updatedAt"
  )
  VALUES (
    $1, $2, $3, $4,
    $5, $6, $7, $8, $9,
    $10, $11, $12, $13, $14,
    $15, $16,
    $17, $18,
    $19, $20, $21, $22,
    $23, $24, $25,
    $26, $26, $26
  )
  ON CONFLICT ("setupHash", "scoredAt") DO UPDATE SET
    direction = EXCLUDED.direction,
    "fibRatio" = EXCLUDED."fibRatio",
    "goType" = EXCLUDED."goType",
    "entryPrice" = EXCLUDED."entryPrice",
    "stopLoss" = EXCLUDED."stopLoss",
    tp1 = EXCLUDED.tp1,
    tp2 = EXCLUDED.tp2,
    "currentPrice" = EXCLUDED."currentPrice",
    "compositeScore" = EXCLUDED."compositeScore",
    grade = EXCLUDED.grade,
    "pTp1" = EXCLUDED."pTp1",
    "pTp2" = EXCLUDED."pTp2",
    "mlSource" = EXCLUDED."mlSource",
    rr = EXCLUDED.rr,
    "dollarRisk" = EXCLUDED."dollarRisk",
    "eventPhase" = EXCLUDED."eventPhase",
    "confidenceAdj" = EXCLUDED."confidenceAdj",
    rationale = EXCLUDED.rationale,
    "reasoningSource" = EXCLUDED."reasoningSource",
    "adjustedPTp1" = EXCLUDED."adjustedPTp1",
    "adjustedPTp2" = EXCLUDED."adjustedPTp2",
    features = EXCLUDED.features,
    "scoreBreakdown" = EXCLUDED."scoreBreakdown",
    flags = EXCLUDED.flags,
    "updatedAt" = EXCLUDED."updatedAt"
`

export async function recordScoredTrades(
  trades: ScoredTrade[],
  currentPrice: number,
  eventContext: EventContext,
): Promise<number> {
  if (trades.length === 0) return 0

  let db
  try {
    db = getDirectPool()
  } catch (err) {
    console.warn('[trade-recorder] direct pool unavailable, skipping:', err)
    return 0
  }

  let inserted = 0

  for (const trade of trades) {
    const hash = makeSetupHash(trade)
    const scoredAt = trade.setup.goTime
      ? new Date(trade.setup.goTime * 1000)
      : new Date()

    try {
      const result = await db.query(INSERT_SQL, [
        hash,
        trade.setup.direction,
        trade.setup.fibRatio,
        trade.setup.goType ?? null,
        trade.setup.entry ?? null,
        trade.setup.stopLoss ?? null,
        trade.setup.tp1 ?? null,
        trade.setup.tp2 ?? null,
        currentPrice,
        trade.score.composite,
        trade.score.grade,
        trade.score.pTp1,
        trade.score.pTp2,
        trade.mlBaseline.source,
        trade.risk?.rr ?? null,
        trade.risk?.dollarRisk ?? null,
        eventContext.phase,
        eventContext.confidenceAdjustment,
        trade.reasoning.rationale ?? null,
        trade.reasoning.source,
        trade.reasoning.adjustedPTp1 ?? null,
        trade.reasoning.adjustedPTp2 ?? null,
        JSON.stringify(trade.features),
        JSON.stringify(trade.score.subScores ?? {}),
        trade.score.flags,
        scoredAt,
      ])
      if (result.rowCount && result.rowCount > 0) inserted++
    } catch (err) {
      console.warn(`[trade-recorder] Failed to record trade ${hash}:`, err)
    }
  }

  if (inserted > 0) {
    console.log(`[trade-recorder] Recorded ${inserted} trades`)
  }

  return inserted
}
