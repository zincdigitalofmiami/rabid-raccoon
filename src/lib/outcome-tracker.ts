/**
 * outcome-tracker.ts — Resolve trade outcomes for both canonical setup records
 * (warbird_setups) and training records (scored_trades).
 */

import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/decimal";

interface CandleRow {
  eventTime: Date;
  high: number;
  low: number;
  close: number;
}

interface OutcomeResult {
  tp1Hit: boolean;
  tp2Hit: boolean;
  slHit: boolean;
  tp1HitTime: Date | null;
  tp2HitTime: Date | null;
  slHitTime: Date | null;
  maxFavorable: number;
  maxAdverse: number;
}

const TP1_HORIZON_MS = 4 * 60 * 60 * 1000;
const TP2_HORIZON_MS = 8 * 60 * 60 * 1000;
const BATCH_SIZE = 50;
const MIN_RUN_INTERVAL_MS = 60 * 1000;

let inFlightOutcomeRun: Promise<number> | null = null;
let lastOutcomeRunAt = 0;

function evaluateOutcome(
  direction: "BULLISH" | "BEARISH",
  entry: number,
  stopLoss: number,
  tp1: number,
  tp2: number | null,
  startTime: Date,
  candles: CandleRow[],
): OutcomeResult {
  const result: OutcomeResult = {
    tp1Hit: false,
    tp2Hit: false,
    slHit: false,
    tp1HitTime: null,
    tp2HitTime: null,
    slHitTime: null,
    maxFavorable: 0,
    maxAdverse: 0,
  };

  const isBull = direction === "BULLISH";
  const startMs = startTime.getTime();

  for (const candle of candles) {
    const elapsed = candle.eventTime.getTime() - startMs;

    if (elapsed <= TP2_HORIZON_MS) {
      if (isBull) {
        result.maxFavorable = Math.max(result.maxFavorable, candle.high - entry);
        result.maxAdverse = Math.max(result.maxAdverse, entry - candle.low);
      } else {
        result.maxFavorable = Math.max(result.maxFavorable, entry - candle.low);
        result.maxAdverse = Math.max(result.maxAdverse, candle.high - entry);
      }
    }

    if (!result.slHit) {
      const slTriggered = isBull ? candle.low <= stopLoss : candle.high >= stopLoss;
      if (slTriggered) {
        result.slHit = true;
        result.slHitTime = candle.eventTime;
      }
    }

    if (!result.tp1Hit && !result.slHit && elapsed <= TP1_HORIZON_MS) {
      const tp1Triggered = isBull ? candle.high >= tp1 : candle.low <= tp1;
      if (tp1Triggered) {
        result.tp1Hit = true;
        result.tp1HitTime = candle.eventTime;
      }
    }

    if (!result.tp2Hit && !result.slHit && elapsed <= TP2_HORIZON_MS && tp2 != null) {
      const tp2Triggered = isBull ? candle.high >= tp2 : candle.low <= tp2;
      if (tp2Triggered) {
        result.tp2Hit = true;
        result.tp2HitTime = candle.eventTime;
      }
    }

    if ((result.tp1Hit || result.slHit) && (result.tp2Hit || result.slHit)) break;
  }

  return result;
}

function deriveWarbirdPhase(outcome: OutcomeResult): "GO_FIRED" | "STOPPED" | "TP1_HIT" | "TP2_HIT" | "EXPIRED" {
  if (outcome.slHit) return "STOPPED";
  if (outcome.tp2Hit) return "TP2_HIT";
  if (outcome.tp1Hit) return "TP1_HIT";
  return "EXPIRED";
}

async function loadMesWindow(start: Date, end: Date): Promise<CandleRow[]> {
  const candles = await prisma.mktFuturesMes15m.findMany({
    where: {
      eventTime: {
        gt: start,
        lte: end,
      },
    },
    orderBy: { eventTime: "asc" },
    select: {
      eventTime: true,
      high: true,
      low: true,
      close: true,
    },
  });

  return candles.map((row) => ({
    eventTime: row.eventTime,
    high: toNum(row.high),
    low: toNum(row.low),
    close: toNum(row.close),
  }));
}

async function resolveWarbirdSetupOutcomes(cutoff: Date): Promise<number> {
  const pending = await prisma.warbirdSetup.findMany({
    where: {
      phase: "GO_FIRED",
      goTime: { lt: cutoff, not: null },
      entry: { not: null },
      stopLoss: { not: null },
      tp1: { not: null },
      tp1Hit: null,
    },
    orderBy: { goTime: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      setupId: true,
      direction: true,
      goTime: true,
      entry: true,
      stopLoss: true,
      tp1: true,
      tp2: true,
    },
  });

  let updated = 0;

  for (const setup of pending) {
    const goTime = setup.goTime;
    if (!goTime) continue;

    const end = new Date(goTime.getTime() + TP2_HORIZON_MS);
    const candles = await loadMesWindow(goTime, end);
    if (candles.length === 0) continue;

    const outcome = evaluateOutcome(
      setup.direction,
      toNum(setup.entry),
      toNum(setup.stopLoss),
      toNum(setup.tp1),
      setup.tp2 != null ? toNum(setup.tp2) : null,
      goTime,
      candles,
    );

    const phase = deriveWarbirdPhase(outcome);

    await prisma.$transaction([
      prisma.warbirdSetup.update({
        where: { id: setup.id },
        data: {
          phase,
          tp1Hit: outcome.tp1Hit,
          tp2Hit: outcome.tp2Hit,
          slHit: outcome.slHit,
          tp1HitTime: outcome.tp1HitTime,
          tp2HitTime: outcome.tp2HitTime,
          slHitTime: outcome.slHitTime,
          maxFavorable: outcome.maxFavorable,
          maxAdverse: outcome.maxAdverse,
        },
      }),
      prisma.scoredTrade.updateMany({
        where: {
          setupHash: setup.setupId,
          outcomeCheckedAt: null,
        },
        data: {
          tp1Hit: outcome.tp1Hit,
          tp2Hit: outcome.tp2Hit,
          slHit: outcome.slHit,
          tp1HitTime: outcome.tp1HitTime,
          tp2HitTime: outcome.tp2HitTime,
          slHitTime: outcome.slHitTime,
          maxFavorable: outcome.maxFavorable,
          maxAdverse: outcome.maxAdverse,
          outcomeCheckedAt: new Date(),
        },
      }),
    ]);

    updated++;
  }

  return updated;
}

async function resolveLegacyScoredTradeOutcomes(cutoff: Date): Promise<number> {
  const pending = await prisma.scoredTrade.findMany({
    where: {
      outcomeCheckedAt: null,
      scoredAt: { lt: cutoff },
      entryPrice: { not: null },
      stopLoss: { not: null },
      tp1: { not: null },
    },
    orderBy: { scoredAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      setupHash: true,
      direction: true,
      entryPrice: true,
      stopLoss: true,
      tp1: true,
      tp2: true,
      scoredAt: true,
    },
  });

  let updated = 0;

  for (const trade of pending) {
    const linkedSetup = await prisma.warbirdSetup.findUnique({
      where: { setupId: trade.setupHash },
      select: { setupId: true },
    });
    if (linkedSetup) continue;

    const end = new Date(trade.scoredAt.getTime() + TP2_HORIZON_MS);
    const candles = await loadMesWindow(trade.scoredAt, end);
    if (candles.length === 0) continue;

    const outcome = evaluateOutcome(
      trade.direction,
      toNum(trade.entryPrice),
      toNum(trade.stopLoss),
      toNum(trade.tp1),
      trade.tp2 != null ? toNum(trade.tp2) : null,
      trade.scoredAt,
      candles,
    );

    await prisma.scoredTrade.update({
      where: { id: trade.id },
      data: {
        tp1Hit: outcome.tp1Hit,
        tp2Hit: outcome.tp2Hit,
        slHit: outcome.slHit,
        tp1HitTime: outcome.tp1HitTime,
        tp2HitTime: outcome.tp2HitTime,
        slHitTime: outcome.slHitTime,
        maxFavorable: outcome.maxFavorable,
        maxAdverse: outcome.maxAdverse,
        outcomeCheckedAt: new Date(),
      },
    });

    updated++;
  }

  return updated;
}

/**
 * Check outcomes for unresolved setup/trade records older than 8 hours.
 */
export async function checkTradeOutcomes(): Promise<number> {
  if (inFlightOutcomeRun) return inFlightOutcomeRun;

  const now = Date.now();
  if (now - lastOutcomeRunAt < MIN_RUN_INTERVAL_MS) return 0;

  lastOutcomeRunAt = now;

  inFlightOutcomeRun = (async () => {
  const cutoff = new Date(Date.now() - TP2_HORIZON_MS);

  const [warbirdUpdated, legacyUpdated] = await Promise.all([
    resolveWarbirdSetupOutcomes(cutoff),
    resolveLegacyScoredTradeOutcomes(cutoff),
  ]);

  const total = warbirdUpdated + legacyUpdated;
  if (total > 0) {
    console.log(
      `[outcome-tracker] Updated outcomes: warbird=${warbirdUpdated}, legacy_scored=${legacyUpdated}`,
    );
  }
  return total;
  })();

  try {
    return await inFlightOutcomeRun;
  } finally {
    inFlightOutcomeRun = null;
  }
}
