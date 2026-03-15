import { NextResponse } from "next/server";
import { signalCache } from "@/lib/tiered-cache";
import type { SignalPayload, ScoredTrade } from "@/inngest/functions/compute-signal";
import type { EventContext } from "@/lib/event-awareness";
import type { calculateFibonacciMultiPeriod } from "@/lib/fibonacci";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

const TRADES_UPCOMING_PAUSED = process.env.PAUSE_TRADES_UPCOMING === "1";
const TRADES_UPCOMING_PAUSE_REASON =
  process.env.PAUSE_TRADES_UPCOMING_REASON || "temporarily paused";

const CACHE_KEY = "upcoming-trades";
const EXPECTED_COMPUTE_CADENCE_SECONDS = 15 * 60;
const RECOVERY_WINDOW_SECONDS = 60;
const STALE_AFTER_SECONDS = EXPECTED_COMPUTE_CADENCE_SECONDS;

type UpcomingTradesRouteStatus =
  | "warm-cache"
  | "cold-cache"
  | "stale-cache"
  | "paused"
  | "runtime-failure";

interface UpcomingTradesMeta {
  status: UpcomingTradesRouteStatus;
  cacheKey: typeof CACHE_KEY;
  cacheAgeSeconds: number | null;
  isStale: boolean;
  expectedCadenceSeconds: number;
  staleAfterSeconds: number;
  recoveryWindowSeconds: number;
  updatedAt: string;
  reason?: string;
}

export interface UpcomingTradesResponse {
  trades: ScoredTrade[];
  eventContext: EventContext;
  currentPrice: number | null;
  fibResult: ReturnType<typeof calculateFibonacciMultiPeriod>;
  timestamp: string;
  computedAt?: string;
  source: "cache";
  error?: string;
  meta: UpcomingTradesMeta;
}

export type { ScoredTrade }

function nowIso(): string {
  return new Date().toISOString();
}

function getCacheAgeSeconds(computedAt?: string): number | null {
  if (!computedAt) return null;
  const computedAtMs = Date.parse(computedAt);
  if (Number.isNaN(computedAtMs)) return null;
  return Math.max(0, Math.floor((Date.now() - computedAtMs) / 1000));
}

function buildMeta(params: {
  status: UpcomingTradesRouteStatus;
  cacheAgeSeconds: number | null;
  reason?: string;
}): UpcomingTradesMeta {
  const isStale =
    params.cacheAgeSeconds == null
      ? params.status !== "warm-cache"
      : params.cacheAgeSeconds > STALE_AFTER_SECONDS;

  return {
    status: params.status,
    cacheKey: CACHE_KEY,
    cacheAgeSeconds: params.cacheAgeSeconds,
    isStale,
    expectedCadenceSeconds: EXPECTED_COMPUTE_CADENCE_SECONDS,
    staleAfterSeconds: STALE_AFTER_SECONDS,
    recoveryWindowSeconds: RECOVERY_WINDOW_SECONDS,
    updatedAt: nowIso(),
    reason: params.reason,
  };
}

export async function GET(): Promise<Response> {
  try {
    if (TRADES_UPCOMING_PAUSED) {
      return NextResponse.json(
        {
          error: `Upcoming trades endpoint paused: ${TRADES_UPCOMING_PAUSE_REASON}`,
          meta: buildMeta({
            status: "paused",
            cacheAgeSeconds: null,
            reason: "pause-flag-enabled",
          }),
        },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }

    const cached = signalCache.get<SignalPayload>(CACHE_KEY);

    if (!cached) {
      return NextResponse.json(
        {
          error:
            "Upcoming trades unavailable: signal cache is empty. Wait for the next compute-signal cycle.",
          meta: buildMeta({
            status: "cold-cache",
            cacheAgeSeconds: null,
            reason: "cache-miss",
          }),
        },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }

    const cacheAgeSeconds = getCacheAgeSeconds(cached.computedAt);
    const isStale =
      cacheAgeSeconds == null || cacheAgeSeconds > STALE_AFTER_SECONDS;
    const status: UpcomingTradesRouteStatus = isStale ? "stale-cache" : "warm-cache";

    return NextResponse.json(
      {
        trades: cached.trades,
        eventContext: cached.eventContext,
        currentPrice: cached.currentPrice,
        fibResult: cached.fibResult,
        timestamp: new Date().toISOString(),
        computedAt: cached.computedAt,
        source: "cache",
        meta: buildMeta({
          status,
          cacheAgeSeconds,
          reason:
            cacheAgeSeconds == null ? "computed-at-missing-or-unparseable" : undefined,
        }),
      } satisfies UpcomingTradesResponse,
      { headers: isStale ? NO_STORE_HEADERS : CACHE_HEADERS },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[trades/upcoming] GET failed:", message);
    return NextResponse.json(
      {
        error: "Upcoming trades unavailable: internal server error.",
        meta: buildMeta({
          status: "runtime-failure",
          cacheAgeSeconds: null,
          reason: "unexpected-route-runtime-failure",
        }),
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
