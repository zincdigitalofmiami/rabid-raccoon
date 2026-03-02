/**
 * direct-pool.ts — Shared direct Postgres connection pool.
 *
 * Bypasses Prisma Accelerate by connecting via DIRECT_URL (or LOCAL_DATABASE_URL
 * in dev). Use this for high-frequency writes (SSE refresh, ingestion) to avoid
 * per-operation Accelerate charges on Vercel production.
 *
 * Pattern proven in production by trade-recorder.ts and outcome-tracker.ts.
 *
 * Why: mes15m-refresh.ts was the #1 Accelerate cost center — 40-op $transaction
 * batches called every 2s from SSE streams. Switching to DIRECT_URL eliminates
 * ~90% of daily Accelerate operations (~57K → ~2K ops/day).
 */

import pg from "pg";

let pool: pg.Pool | null = null;

/**
 * Returns a shared pg.Pool connected via DIRECT_URL (prod) or LOCAL_DATABASE_URL (dev).
 * Max 3 connections — sufficient for serial ingestion and SSE refresh workloads.
 */
export function getDirectPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DIRECT_URL || process.env.LOCAL_DATABASE_URL;
    if (!url) {
      throw new Error(
        "DIRECT_URL (or LOCAL_DATABASE_URL) not set — cannot create direct pool",
      );
    }
    pool = new pg.Pool({ connectionString: url, max: 3 });
  }
  return pool;
}
