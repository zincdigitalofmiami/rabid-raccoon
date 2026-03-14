import { serve } from "inngest/next";
import { NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import * as inngestRegistry from "@/inngest";
import {
  // Market Data (Databento) — 7 functions
  ingestMktMes1m,
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

const SERVED_EXPORT_NAMES = [
  "ingestMktMes1m",
  "ingestMktEquityIndices",
  "ingestMktTreasuries",
  "ingestMktCommodities",
  "ingestMktFxRates",
  "ingestEconRates",
  "ingestEconYields",
  "ingestEconVolIndices",
  "ingestEconInflation",
  "ingestEconFx",
  "ingestEconLabor",
  "ingestEconActivity",
  "ingestEconCommodities",
  "ingestEconMoney",
  "ingestEconIndexes",
  "ingestEconCalendar",
  "ingestNewsSignals",
  "ingestAltNews",
  "ingestFredNews",
  "ingestMeasuredMoves",
  "computeSignal",
  "checkOutcomes",
  "ingestGprIndex",
  "ingestTrumpEffect",
  "checkSymbolCoverage",
  "backfillMesAllTimeframes",
] as const;

const SERVED_FUNCTIONS = [
  // Market Data (Databento)
  ingestMktMes1m, // authoritative 1m writer, every minute when market is open
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
] as const;

const PROBE_HEADERS = {
  "Cache-Control": "no-store",
};

// Only use INNGEST_SERVE_HOST on real Vercel (VERCEL_URL is set by the
// platform; .env.production.local sets it to "" when pulled locally via
// `vercel env pull`, so this guard keeps the dev server from advertising
// the production URL and breaking local Inngest connections).
const serveHost = (process.env.VERCEL_URL ? process.env.INNGEST_SERVE_HOST : "") || "";

const handlers = serve({
  client: inngest,
  ...(serveHost && { serveHost }),
  functions: [...SERVED_FUNCTIONS],
});

export const PUT = handlers.PUT;

function buildProbeHealthPayload(request: Request) {
  const servedFunctions = SERVED_FUNCTIONS.map((fn, index) => {
    const id = (fn as { id?: unknown }).id;
    return {
      exportName: SERVED_EXPORT_NAMES[index],
      functionId: typeof id === "string" ? id : null,
    };
  });

  const exportedFunctions = Object.keys(inngestRegistry)
    .filter((name) => name !== "__esModule" && name !== "default")
    .sort();
  const servedExportNames = [...SERVED_EXPORT_NAMES].map((name) => String(name)).sort();
  const servedSet = new Set(servedExportNames);
  const exportedSet = new Set(exportedFunctions);
  const exportedNotServed = exportedFunctions.filter((name) => !servedSet.has(name));
  const servedNotExported = servedExportNames.filter((name) => !exportedSet.has(name));

  return {
    ok: true,
    probe: "health",
    route: "/api/inngest",
    status: "serve-surface-healthy",
    serveSurface: {
      mounted: true,
      servedFunctionCount: servedFunctions.length,
      servedFunctions,
    },
    runtimeHealth: {
      status: "unknown",
      verifiedByRoute: false,
      reason:
        "This probe verifies route mount + served surface metadata only; it does not execute or verify downstream function runtime.",
    },
    registrySurface: {
      exportedFunctionCount: exportedFunctions.length,
      servedExportNamesCount: servedExportNames.length,
      exportedNotServed,
      servedNotExported,
      hasDrift: exportedNotServed.length > 0 || servedNotExported.length > 0,
    },
    requestedUrl: request.url,
    updatedAt: new Date().toISOString(),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("probe") === "health") {
    return NextResponse.json(buildProbeHealthPayload(request), {
      headers: PROBE_HEADERS,
    });
  }
  return handlers.GET(request as never, undefined);
}

function normalizeProbeRequest(request: Request): Request {
  const url = new URL(request.url);
  if (url.searchParams.get("probe") !== "ping") return request;
  url.searchParams.set("probe", "trust");
  return new Request(url, request);
}

export async function POST(request: Request) {
  return handlers.POST(normalizeProbeRequest(request) as never, undefined);
}
