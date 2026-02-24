/**
 * outcome-tracker.ts — Check scored trades against subsequent price data.
 *
 * For each unresolved trade (outcome_checked_at IS NULL), loads
 * MES 15m candles after the scored_at time and checks whether:
 *   - TP1 was hit before stop loss (within 4h)
 *   - TP2 was hit before stop loss (within 8h)
 *   - Stop loss was hit
 *   - Max favorable excursion (MFE) and max adverse excursion (MAE)
 *
 * Uses DIRECT_URL to bypass Prisma Accelerate, same as trade-recorder.
 */

import pg from 'pg'

// ─────────────────────────────────────────────
// Connection pool
// ─────────────────────────────────────────────

let pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DIRECT_URL
    if (!url) throw new Error('DIRECT_URL not set')
    pool = new pg.Pool({ connectionString: url, max: 2 })
  }
  return pool
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface PendingTrade {
  id: string  // bigint comes as string from pg
  direction: 'BULLISH' | 'BEARISH'
  entry_price: number | null
  stop_loss: number | null
  tp1: number | null
  tp2: number | null
  scored_at: Date
}

interface CandleRow {
  event_time: Date
  high: number
  low: number
  close: number
}

interface OutcomeResult {
  tp1Hit: boolean
  tp2Hit: boolean
  slHit: boolean
  tp1HitTime: Date | null
  tp2HitTime: Date | null
  slHitTime: Date | null
  maxFavorable: number  // MFE in points
  maxAdverse: number    // MAE in points
}

// ─────────────────────────────────────────────
// Horizon constants
// ─────────────────────────────────────────────

const TP1_HORIZON_MS = 4 * 60 * 60 * 1000  // 4 hours
const TP2_HORIZON_MS = 8 * 60 * 60 * 1000  // 8 hours

// ─────────────────────────────────────────────
// Core logic
// ─────────────────────────────────────────────

function evaluateOutcome(
  trade: PendingTrade,
  candles: CandleRow[],
): OutcomeResult {
  const result: OutcomeResult = {
    tp1Hit: false, tp2Hit: false, slHit: false,
    tp1HitTime: null, tp2HitTime: null, slHitTime: null,
    maxFavorable: 0, maxAdverse: 0,
  }

  if (!trade.entry_price || !trade.stop_loss || !trade.tp1) return result

  const entry = trade.entry_price
  const sl = trade.stop_loss
  const tp1 = trade.tp1
  const tp2 = trade.tp2
  const isBull = trade.direction === 'BULLISH'
  const scoredMs = trade.scored_at.getTime()

  for (const candle of candles) {
    const candleMs = candle.event_time.getTime()
    const elapsed = candleMs - scoredMs

    // MFE/MAE tracking (full 8h window)
    if (elapsed <= TP2_HORIZON_MS) {
      if (isBull) {
        result.maxFavorable = Math.max(result.maxFavorable, candle.high - entry)
        result.maxAdverse = Math.max(result.maxAdverse, entry - candle.low)
      } else {
        result.maxFavorable = Math.max(result.maxFavorable, entry - candle.low)
        result.maxAdverse = Math.max(result.maxAdverse, candle.high - entry)
      }
    }

    // Stop loss check (any time)
    if (!result.slHit) {
      const slTriggered = isBull
        ? candle.low <= sl
        : candle.high >= sl

      if (slTriggered) {
        result.slHit = true
        result.slHitTime = candle.event_time
      }
    }

    // TP1 check (4h horizon, only if SL not hit first)
    if (!result.tp1Hit && !result.slHit && elapsed <= TP1_HORIZON_MS) {
      const tp1Triggered = isBull
        ? candle.high >= tp1
        : candle.low <= tp1

      if (tp1Triggered) {
        result.tp1Hit = true
        result.tp1HitTime = candle.event_time
      }
    }

    // TP2 check (8h horizon, only if SL not hit first)
    if (!result.tp2Hit && !result.slHit && elapsed <= TP2_HORIZON_MS && tp2 != null) {
      const tp2Triggered = isBull
        ? candle.high >= tp2
        : candle.low <= tp2

      if (tp2Triggered) {
        result.tp2Hit = true
        result.tp2HitTime = candle.event_time
      }
    }

    // Early exit if all resolved
    if ((result.tp1Hit || result.slHit) && (result.tp2Hit || result.slHit)) break
  }

  return result
}

// ─────────────────────────────────────────────
// Main checker
// ─────────────────────────────────────────────

/**
 * Check outcomes for all unresolved scored trades.
 * Only checks trades older than 8 hours (so the full TP2 horizon has passed).
 * Returns count of trades updated.
 */
export async function checkTradeOutcomes(): Promise<number> {
  const directUrl = process.env.DIRECT_URL
  if (!directUrl) {
    console.warn('[outcome-tracker] DIRECT_URL not set, skipping')
    return 0
  }

  const db = getPool()

  // Find trades that need outcome checking (scored > 8h ago, not yet checked)
  const cutoff = new Date(Date.now() - TP2_HORIZON_MS)
  const pending = await db.query<PendingTrade>(`
    SELECT id, direction, entry_price, stop_loss, tp1, tp2, scored_at
    FROM scored_trades
    WHERE outcome_checked_at IS NULL
      AND scored_at < $1
      AND entry_price IS NOT NULL
    ORDER BY scored_at ASC
    LIMIT 50
  `, [cutoff])

  if (pending.rows.length === 0) return 0

  let updated = 0

  for (const trade of pending.rows) {
    // Load candles from scored_at to scored_at + 8h
    const windowEnd = new Date(trade.scored_at.getTime() + TP2_HORIZON_MS)
    const candles = await db.query<CandleRow>(`
      SELECT event_time, high::float, low::float, close::float
      FROM mkt_futures_mes_15m
      WHERE event_time > $1 AND event_time <= $2
      ORDER BY event_time ASC
    `, [trade.scored_at, windowEnd])

    if (candles.rows.length === 0) continue

    // Cast numeric strings to numbers
    const rows = candles.rows.map(r => ({
      ...r,
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    }))

    const outcome = evaluateOutcome({
      ...trade,
      entry_price: Number(trade.entry_price),
      stop_loss: Number(trade.stop_loss),
      tp1: trade.tp1 ? Number(trade.tp1) : null,
      tp2: trade.tp2 ? Number(trade.tp2) : null,
    }, rows)

    // Update the trade record
    await db.query(`
      UPDATE scored_trades SET
        tp1_hit = $2,
        tp2_hit = $3,
        sl_hit = $4,
        tp1_hit_time = $5,
        tp2_hit_time = $6,
        sl_hit_time = $7,
        max_favorable = $8,
        max_adverse = $9,
        outcome_checked_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `, [
      trade.id,
      outcome.tp1Hit,
      outcome.tp2Hit,
      outcome.slHit,
      outcome.tp1HitTime,
      outcome.tp2HitTime,
      outcome.slHitTime,
      outcome.maxFavorable,
      outcome.maxAdverse,
    ])

    updated++
  }

  if (updated > 0) {
    console.log(`[outcome-tracker] Updated ${updated} trade outcomes`)
  }

  return updated
}
