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

export interface UpcomingTradesResponse {
  trades: ScoredTrade[];
  eventContext: EventContext;
  currentPrice: number | null;
  fibResult: ReturnType<typeof calculateFibonacciMultiPeriod>;
  timestamp: string;
  computedAt?: string;
  source: "cache";
  error?: string;
}

export type { ScoredTrade }

export async function GET(): Promise<Response> {
  try {
    const cached = signalCache.get<SignalPayload>("upcoming-trades");

    if (!cached) {
      return NextResponse.json(
        {
          error:
            "Upcoming trades unavailable: signal cache is empty. Wait for the next compute-signal cycle.",
        },
        { status: 503, headers: CACHE_HEADERS },
      );
    }

    return NextResponse.json(
      {
        trades: cached.trades,
        eventContext: cached.eventContext,
        currentPrice: cached.currentPrice,
        fibResult: cached.fibResult,
        timestamp: new Date().toISOString(),
        computedAt: cached.computedAt,
        source: "cache",
      } satisfies UpcomingTradesResponse,
      { headers: CACHE_HEADERS },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[trades/upcoming] GET failed:", message);
    return NextResponse.json(
      { error: "Upcoming trades unavailable: internal server error." },
      { status: 500, headers: CACHE_HEADERS },
    );
  }
}
