import { getDirectPool } from "./direct-pool";

export interface MesPriceRow {
  eventTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
