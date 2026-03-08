import { NextRequest, NextResponse } from "next/server";
import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import {
  // Market Data (Databento) — 6 functions
  ingestMktMes15m,
  ingestMktMes1h,
  ingestMktEquityIndices,
  ingestMktTreasuries,
  ingestMktCommodities,
  ingestMktFxRates,
  // FRED Economic Series — 10 functions
  ingestEconRates,
  ingestEconYields,
  ingestEconVolIndices,
  ingestEconInflation,
  ingestEconFx,
  ingestEconLabor,
  ingestEconActivity,
  ingestEconCommodities,
  ingestEconMoney,
  ingestEconIndexes,
  // Events / News — 4 functions
  ingestEconCalendar,
  ingestNewsSignals,
  ingestAltNews,
  ingestFredNews,
  // Signals — 1 function
  ingestMeasuredMoves,
  // 15m Signal Pipeline — 2 functions
  computeSignal,
  checkOutcomes,
  // Geopolitical / policy — 2 functions
  ingestGprIndex,
  ingestTrumpEffect,
  // Coverage audit — 1 function (weekly)
  checkSymbolCoverage,
  // Backfill — 1 function (event-triggered)
  backfillMesAllTimeframes,
} from "@/inngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Only use INNGEST_SERVE_HOST on real Vercel (VERCEL_URL is set by the
// platform; .env.production.local sets it to "" when pulled locally via
// `vercel env pull`, so this guard keeps the dev server from advertising
// the production URL and breaking local Inngest connections).
const serveHost = (process.env.VERCEL_URL ? process.env.INNGEST_SERVE_HOST : "") || "";

const handlers = serve({
  client: inngest,
  ...(serveHost && { serveHost }),
  functions: [
    // Market Data (Databento)
    ingestMktMes15m, // every hour at :05
    ingestMktMes1h, // daily at 00:00 UTC
    ingestMktEquityIndices,
    ingestMktTreasuries,
    ingestMktCommodities,
    ingestMktFxRates,
    // FRED Econ (05:00–14:00 UTC, 1hr apart)
    ingestEconRates,
    ingestEconYields,
    ingestEconVolIndices,
    ingestEconInflation,
    ingestEconFx,
    ingestEconLabor,
    ingestEconActivity,
    ingestEconCommodities,
    ingestEconMoney,
    ingestEconIndexes,
    // Events / News (15:00–17:15 UTC)
    ingestEconCalendar,
    ingestNewsSignals,
    ingestAltNews,
    ingestFredNews, // daily at 17:15 UTC
    // Signals (18:00 UTC)
    ingestMeasuredMoves,
    // 15m Signal Pipeline
    computeSignal,
    checkOutcomes,
    // Geopolitical / policy (19:00–19:30 UTC)
    ingestGprIndex,
    ingestTrumpEffect,
    // Coverage audit (weekly Sun 06:00 UTC)
    checkSymbolCoverage,
    // Backfill (event-triggered)
    backfillMesAllTimeframes,
  ],
});

function isDeployedCloudRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_URL);
}

function disabledResponse() {
  return NextResponse.json(
    {
      ok: false,
      disabled: true,
      reason: "cloud_inngest_endpoint_disabled",
      route: "/api/inngest",
    },
    { status: 403 },
  );
}

export async function GET(request: NextRequest, context: unknown) {
  if (isDeployedCloudRuntime()) return disabledResponse();
  return handlers.GET(request, context as Parameters<typeof handlers.GET>[1]);
}

export async function POST(request: NextRequest, context: unknown) {
  if (isDeployedCloudRuntime()) return disabledResponse();
  return handlers.POST(request, context as Parameters<typeof handlers.POST>[1]);
}

export async function PUT(request: NextRequest, context: unknown) {
  if (isDeployedCloudRuntime()) return disabledResponse();
  return handlers.PUT(request, context as Parameters<typeof handlers.PUT>[1]);
}
