import { getDirectPool } from "./direct-pool";

export interface MesPriceRow {
  eventTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const MES_1M_OWNER_PATH = {
  writerFunctionId: "ingest-mkt-mes-1m",
  writerFunctionFile: "src/inngest/functions/mkt-mes-1m.ts",
  upstreamProvider: "databento",
  sourceTable: "mkt_futures_mes_1m",
  expectedCadenceSeconds: 60,
  lagAlertSeconds: 180,
} as const;

export interface Mes1mFreshnessSnapshot {
  latestEventTime: Date | null;
  rowsLast5m: number;
  rowsLast15m: number;
  rowsLast60m: number;
}

const TABLES = {
  mes1m: '"mkt_futures_mes_1m"',
  mes15m: '"mkt_futures_mes_15m"',
} as const;

type MesTable = keyof typeof TABLES;

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function asNullableDate(value: unknown): Date | null {
  if (value == null) return null;
  const date = asDate(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function readLatestMesRows(
  table: MesTable,
  limit: number,
): Promise<MesPriceRow[]> {
  const pool = getDirectPool();
  const safeLimit = Math.max(1, Math.trunc(limit));
  const result = await pool.query<{
    eventTime: Date;
    open: number | string;
    high: number | string;
    low: number | string;
    close: number | string;
    volume: number | string | null;
  }>(
    `
      SELECT
        "eventTime",
        "open"::double precision AS "open",
        "high"::double precision AS "high",
        "low"::double precision AS "low",
        "close"::double precision AS "close",
        COALESCE("volume", 0)::double precision AS "volume"
      FROM ${TABLES[table]}
      ORDER BY "eventTime" DESC
      LIMIT $1
    `,
    [safeLimit],
  );

  return result.rows.map((row) => ({
    eventTime: asDate(row.eventTime),
    open: asNumber(row.open),
    high: asNumber(row.high),
    low: asNumber(row.low),
    close: asNumber(row.close),
    volume: asNumber(row.volume),
  }));
}

export async function readLatestMes1mRows(limit: number): Promise<MesPriceRow[]> {
  return readLatestMesRows("mes1m", limit);
}

export async function readLatestMes15mRows(
  limit: number,
): Promise<MesPriceRow[]> {
  return readLatestMesRows("mes15m", limit);
}

export async function readMes1mFreshnessSnapshot(): Promise<Mes1mFreshnessSnapshot> {
  const pool = getDirectPool();
  const result = await pool.query<{
    latestEventTime: Date | string | null;
    rowsLast5m: number | string;
    rowsLast15m: number | string;
    rowsLast60m: number | string;
  }>(
    `
      SELECT
        MAX("eventTime") AS "latestEventTime",
        COUNT(*) FILTER (
          WHERE "eventTime" >= NOW() - INTERVAL '5 minutes'
        )::integer AS "rowsLast5m",
        COUNT(*) FILTER (
          WHERE "eventTime" >= NOW() - INTERVAL '15 minutes'
        )::integer AS "rowsLast15m",
        COUNT(*) FILTER (
          WHERE "eventTime" >= NOW() - INTERVAL '60 minutes'
        )::integer AS "rowsLast60m"
      FROM ${TABLES.mes1m}
    `,
  );

  const row = result.rows[0] ?? {
    latestEventTime: null,
    rowsLast5m: 0,
    rowsLast15m: 0,
    rowsLast60m: 0,
  };

  return {
    latestEventTime: asNullableDate(row.latestEventTime),
    rowsLast5m: asNumber(row.rowsLast5m),
    rowsLast15m: asNumber(row.rowsLast15m),
    rowsLast60m: asNumber(row.rowsLast60m),
  };
}
