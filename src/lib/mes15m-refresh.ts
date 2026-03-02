import { createHash } from "node:crypto";
import { getDirectPool } from "./direct-pool";
import { fetchOhlcv, toCandles } from "./databento";
import type { CandleData } from "./types";

const MES_DATASET = "GLBX.MDP3";
const MES_SYMBOL = "MES.c.0";
const SOURCE_SCHEMA = "ohlcv-1m";
const FIFTEEN_MIN_SECONDS = 15 * 60;
const DEFAULT_LOOKBACK_MINUTES = 18 * 60;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30_000;
const MAX_CANDLES_TO_UPSERT = 500;
const MAX_1M_CANDLES_TO_UPSERT = 1200; // ~20 hours of 1m bars
const BATCH_SIZE = 40;

let lastRefreshAttemptAtMs = 0;

interface RefreshResult {
  attempted: boolean;
  refreshed: boolean;
  rowsUpserted: number;
  latestEventTime: Date | null;
  reason?: string;
}

function asUtcDateFromUnixSeconds(seconds: number): Date {
  return new Date(seconds * 1000);
}

function hashPriceRow(eventTime: Date, close: number): string {
  return createHash("sha256")
    .update(`MES-15M|${eventTime.toISOString()}|${close}`)
    .digest("hex");
}

function hash1mRow(eventTime: Date, close: number): string {
  return createHash("sha256")
    .update(`MES-1M|${eventTime.toISOString()}|${close}`)
    .digest("hex");
}

function dedupeAndSort(candles: CandleData[]): CandleData[] {
  const byTime = new Map<number, CandleData>();
  for (const candle of candles) byTime.set(candle.time, candle);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function aggregateTo15m(candles: CandleData[]): CandleData[] {
  if (candles.length === 0) return [];

  const out: CandleData[] = [];
  let bucket: CandleData | null = null;
  let bucketStart = 0;

  for (const candle of candles) {
    const aligned =
      Math.floor(candle.time / FIFTEEN_MIN_SECONDS) * FIFTEEN_MIN_SECONDS;
    if (!bucket || aligned !== bucketStart) {
      if (bucket) out.push(bucket);
      bucket = {
        time: aligned,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
      };
      bucketStart = aligned;
      continue;
    }

    bucket.high = Math.max(bucket.high, candle.high);
    bucket.low = Math.min(bucket.low, candle.low);
    bucket.close = candle.close;
    bucket.volume = (bucket.volume || 0) + (candle.volume || 0);
  }

  if (bucket) out.push(bucket);
  return out;
}

async function currentLatestEventTime(): Promise<Date | null> {
  const pool = getDirectPool();
  const result = await pool.query(
    'SELECT "eventTime" FROM "mkt_futures_mes_15m" ORDER BY "eventTime" DESC LIMIT 1',
  );
  return result.rows[0]?.eventTime ?? null;
}

export async function refreshMes15mFromDatabento(options?: {
  force?: boolean;
  lookbackMinutes?: number;
  minRefreshIntervalMs?: number;
}): Promise<RefreshResult> {
  const force = options?.force === true;
  const minRefreshIntervalMs = Math.max(
    5_000,
    options?.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS,
  );

  if (!force && Date.now() - lastRefreshAttemptAtMs < minRefreshIntervalMs) {
    return {
      attempted: false,
      refreshed: false,
      rowsUpserted: 0,
      latestEventTime: await currentLatestEventTime(),
      reason: "refresh-throttled",
    };
  }

  if (!process.env.DATABENTO_API_KEY) {
    return {
      attempted: false,
      refreshed: false,
      rowsUpserted: 0,
      latestEventTime: await currentLatestEventTime(),
      reason: "missing-databento-api-key",
    };
  }

  lastRefreshAttemptAtMs = Date.now();

  try {
    const lookbackMinutes = Math.max(
      120,
      options?.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES,
    );
    const end = new Date();
    const start = new Date(end.getTime() - lookbackMinutes * 60 * 1000);

    const records = await fetchOhlcv({
      dataset: MES_DATASET,
      symbol: MES_SYMBOL,
      stypeIn: "continuous",
      start: start.toISOString(),
      end: end.toISOString(),
      schema: SOURCE_SCHEMA,
      timeoutMs: 20_000,
      maxAttempts: 2,
    });

    const sorted1m = dedupeAndSort(toCandles(records));

    // ── Store raw 1m bars (zero extra cost — data already in memory) ────────
    const candles1m = sorted1m.slice(-MAX_1M_CANDLES_TO_UPSERT);
    if (candles1m.length > 0) {
      const UPSERT_1M_SQL = `
        INSERT INTO "mkt_futures_mes_1m" (
          "eventTime", "open", "high", "low", "close", "volume",
          "source", "sourceDataset", "sourceSchema", "rowHash",
          "ingestedAt", "knowledgeTime"
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'DATABENTO'::"DataSource", $7, $8, $9, NOW(), NOW())
        ON CONFLICT ("eventTime") DO UPDATE SET
          "open" = EXCLUDED."open",
          "high" = EXCLUDED."high",
          "low" = EXCLUDED."low",
          "close" = EXCLUDED."close",
          "volume" = EXCLUDED."volume",
          "rowHash" = EXCLUDED."rowHash",
          "ingestedAt" = NOW(),
          "knowledgeTime" = NOW()
      `;
      const pool1m = getDirectPool();
      const client1m = await pool1m.connect();
      try {
        for (let i = 0; i < candles1m.length; i += BATCH_SIZE) {
          const batch = candles1m.slice(i, i + BATCH_SIZE);
          await client1m.query("BEGIN");
          for (const candle of batch) {
            const eventTime = asUtcDateFromUnixSeconds(candle.time);
            await client1m.query(UPSERT_1M_SQL, [
              eventTime,
              candle.open,
              candle.high,
              candle.low,
              candle.close,
              Math.max(0, Math.trunc(candle.volume || 0)),
              MES_DATASET,
              SOURCE_SCHEMA,
              hash1mRow(eventTime, candle.close),
            ]);
          }
          await client1m.query("COMMIT");
        }
      } catch (err1m) {
        await client1m.query("ROLLBACK").catch(() => {});
        // Don't fail the whole refresh if 1m storage fails — 15m is still primary
        console.error("[mes-refresh] 1m upsert failed:", err1m);
      } finally {
        client1m.release();
      }
    }

    // ── Aggregate to 15m (existing pipeline) ────────────────────────────────
    const candles15m = aggregateTo15m(sorted1m).slice(
      -MAX_CANDLES_TO_UPSERT,
    );
    if (candles15m.length === 0) {
      return {
        attempted: true,
        refreshed: false,
        rowsUpserted: 0,
        latestEventTime: await currentLatestEventTime(),
        reason: "no-candles-returned",
      };
    }

    // Batch upserts via DIRECT_URL (bypasses Accelerate — $0 per op).
    // Previous Prisma $transaction approach cost ~57K Accelerate ops/day.
    const UPSERT_SQL = `
      INSERT INTO "mkt_futures_mes_15m" (
        "eventTime", "open", "high", "low", "close", "volume",
        "source", "sourceDataset", "sourceSchema", "rowHash",
        "ingestedAt", "knowledgeTime"
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'DATABENTO'::"DataSource", $7, $8, $9, NOW(), NOW())
      ON CONFLICT ("eventTime") DO UPDATE SET
        "open" = EXCLUDED."open",
        "high" = EXCLUDED."high",
        "low" = EXCLUDED."low",
        "close" = EXCLUDED."close",
        "volume" = EXCLUDED."volume",
        "source" = EXCLUDED."source",
        "sourceDataset" = EXCLUDED."sourceDataset",
        "sourceSchema" = EXCLUDED."sourceSchema",
        "rowHash" = EXCLUDED."rowHash",
        "ingestedAt" = NOW(),
        "knowledgeTime" = NOW()
    `;
    let rowsUpserted = 0;
    const pool = getDirectPool();
    const client = await pool.connect();
    try {
      for (let i = 0; i < candles15m.length; i += BATCH_SIZE) {
        const batch = candles15m.slice(i, i + BATCH_SIZE);
        await client.query("BEGIN");
        for (const candle of batch) {
          const eventTime = asUtcDateFromUnixSeconds(candle.time);
          await client.query(UPSERT_SQL, [
            eventTime,
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            Math.max(0, Math.trunc(candle.volume || 0)),
            MES_DATASET,
            `${SOURCE_SCHEMA}->15m`,
            hashPriceRow(eventTime, candle.close),
          ]);
        }
        await client.query("COMMIT");
        rowsUpserted += batch.length;
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return {
      attempted: true,
      refreshed: true,
      rowsUpserted,
      latestEventTime: asUtcDateFromUnixSeconds(
        candles15m[candles15m.length - 1].time,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      attempted: true,
      refreshed: false,
      rowsUpserted: 0,
      latestEventTime: await currentLatestEventTime(),
      reason: message,
    };
  }
}
