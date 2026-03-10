import { toNum } from "./decimal";
import {
  readLatestMes1mRows,
  readLatestMes15mRows,
  type MesPriceRow,
} from "./mes-live-queries";

const FIFTEEN_MIN_SECONDS = 15 * 60;
const MIN_1M_LOOKBACK = 2400;
const LOOKBACK_PADDING_MINUTES = 240;
const DEFAULT_DERIVED_TOLERANCE_BARS = 5;

function sanitize1mRows(rows: MesPriceRow[]): MesPriceRow[] {
  if (rows.length === 0) return [];

  const sorted = [...rows].sort(
    (a, b) => a.eventTime.getTime() - b.eventTime.getTime(),
  );

  const clean: MesPriceRow[] = [];
  let prevClose: number | null = null;

  for (const row of sorted) {
    const o = toNum(row.open);
    const h = toNum(row.high);
    const l = toNum(row.low);
    const c = toNum(row.close);

    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    if (h < l) continue;
    if ((h - l) / Math.max(o, 1) > 0.08) continue;

    if (prevClose != null && prevClose > 0) {
      if (Math.abs(o - prevClose) / prevClose > 0.08) continue;
      if (Math.abs(c - prevClose) / prevClose > 0.08) continue;
      if (h > prevClose * 1.12) continue;
      if (l < prevClose * 0.88) continue;
    }

    clean.push({
      eventTime: row.eventTime,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: row.volume ?? 0,
    });
    prevClose = c;
  }

  return clean;
}

export function aggregateMes1mRowsTo15m(rows: MesPriceRow[]): MesPriceRow[] {
  if (rows.length === 0) return [];

  const sorted = sanitize1mRows(rows);
  if (sorted.length === 0) return [];

  const out: MesPriceRow[] = [];
  let bucketStartSec = -1;
  let bucket: MesPriceRow | null = null;

  for (const row of sorted) {
    const sec = Math.floor(row.eventTime.getTime() / 1000);
    const alignedSec =
      Math.floor(sec / FIFTEEN_MIN_SECONDS) * FIFTEEN_MIN_SECONDS;
    const alignedTime = new Date(alignedSec * 1000);

    if (!bucket || alignedSec !== bucketStartSec) {
      if (bucket) out.push(bucket);
      bucketStartSec = alignedSec;
      bucket = {
        eventTime: alignedTime,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume ?? 0,
      };
      continue;
    }

    bucket.high = Math.max(toNum(bucket.high), toNum(row.high));
    bucket.low = Math.min(toNum(bucket.low), toNum(row.low));
    bucket.close = row.close;
    bucket.volume = (bucket.volume ?? 0) + (row.volume ?? 0);
  }

  if (bucket) out.push(bucket);
  return out;
}

function defaultOneMinuteLookback(limit: number): number {
  return Math.max(limit * 15 + LOOKBACK_PADDING_MINUTES, MIN_1M_LOOKBACK);
}

function resolveMinimumDerivedBars(
  limit: number,
  minimumDerivedBars?: number,
): number {
  const safeLimit = Math.max(1, Math.trunc(limit));
  if (minimumDerivedBars == null) {
    return Math.max(1, safeLimit - DEFAULT_DERIVED_TOLERANCE_BARS);
  }

  return Math.min(safeLimit, Math.max(1, Math.trunc(minimumDerivedBars)));
}

export function shouldUseDerivedMes15mRows(params: {
  derivedCount: number;
  requestedLimit: number;
  minimumDerivedBars?: number;
}): boolean {
  const required = resolveMinimumDerivedBars(
    params.requestedLimit,
    params.minimumDerivedBars,
  );
  return Math.max(0, Math.trunc(params.derivedCount)) >= required;
}

export async function readLatestMes15mRowsPrefer1m(
  limit: number,
  minimumDerivedBars?: number,
): Promise<MesPriceRow[]> {
  const safeLimit = Math.max(1, Math.trunc(limit));
  const oneMinuteRows = await readLatestMes1mRows(defaultOneMinuteLookback(safeLimit));
  const derivedAsc = aggregateMes1mRowsTo15m(oneMinuteRows);
  const derivedDesc = derivedAsc.slice(-safeLimit).reverse();

  if (
    shouldUseDerivedMes15mRows({
      derivedCount: derivedDesc.length,
      requestedLimit: safeLimit,
      minimumDerivedBars,
    })
  ) {
    return derivedDesc;
  }

  return readLatestMes15mRows(safeLimit);
}
