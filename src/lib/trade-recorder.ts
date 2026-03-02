/**
 * trade-recorder.ts — Persist scored trades to the database for training.
 *
 * Uses pg connection in local-first order:
 * LOCAL_DATABASE_URL → DIRECT_URL.
 * The scored_trades table is created by scripts/create-scored-trades.ts.
 */

import pg from 'pg'
import { createHash } from 'crypto'
import type { ScoredTrade } from '@/app/api/trades/upcoming/route'
import type { EventContext } from '@/lib/event-awareness'
import { logResolvedDbTarget, resolveDirectPgUrl } from './db-url'

// ─────────────────────────────────────────────
// Connection pool (reused across requests)
// ─────────────────────────────────────────────

let pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!pool) {
    const target = resolveDirectPgUrl()
    logResolvedDbTarget('trade-recorder:getPool', target)
    pool = new pg.Pool({ connectionString: target.url, max: 2 })
  }
  return pool
}

// ─────────────────────────────────────────────
// Setup hash (dedup key)
// ─────────────────────────────────────────────

function makeSetupHash(trade: ScoredTrade): string {
  const s = trade.setup
  const window = Math.floor(Date.now() / (15 * 60 * 1000))
  const input = [
    s.direction,
    s.fibRatio.toFixed(3),
    s.fibLevel.toFixed(2),
    s.entry?.toFixed(2) ?? 'none',
    s.stopLoss?.toFixed(2) ?? 'none',
    s.goType ?? 'none',
    window,
  ].join('|')

  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

// ─────────────────────────────────────────────
// Record trades
// ─────────────────────────────────────────────

const INSERT_SQL = `
  INSERT INTO scored_trades (
    setup_hash, direction, fib_ratio, go_type,
    entry_price, stop_loss, tp1, tp2, current_price,
    composite_score, grade, p_tp1, p_tp2, ml_source,
    rr, dollar_risk,
    event_phase, confidence_adj,
    rationale, reasoning_source, adjusted_p_tp1, adjusted_p_tp2,
    features, score_breakdown, flags,
    scored_at, created_at, updated_at
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
  ON CONFLICT (setup_hash, scored_at) DO NOTHING
`

export async function recordScoredTrades(
  trades: ScoredTrade[],
  currentPrice: number,
  eventContext: EventContext,
): Promise<number> {
  if (trades.length === 0) return 0

  let target
  try {
    target = resolveDirectPgUrl()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[trade-recorder] DB URL resolution failed, skipping: ${message}`)
    return 0
  }
  logResolvedDbTarget('recordScoredTrades', target)

  const db = getPool()
  const now = new Date()
  let inserted = 0

  for (const trade of trades) {
    const hash = makeSetupHash(trade)

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
        now,
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
