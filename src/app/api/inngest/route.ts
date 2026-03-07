import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import {
  ingestMktMes15m,
  ingestEconCalendar,
  computeSignal,
  backfillMesAllTimeframes,
} from "@/inngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Inngest serve — cloud-facing runtime jobs only.
 *
 * Functions registered here:
 *   ingestMktMes15m   — MES 15m candle refresh, every hour at :05
 *   ingestEconCalendar — Economic calendar + Treasury rates, daily 15:00 UTC
 *   computeSignal      — Fib retracement + Warbird AI pipeline, every 15 min
 *   backfillMesAllTimeframes — event-triggered historical backfill
 *
 * Heavy batch jobs (FRED, daily market data, news, GPR, Trump) run as
 * local scripts via `scripts/run-batch-ingest.sh`. They are NOT registered
 * here — they have no business being in cloud orchestration.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    ingestMktMes15m,         // every hour at :05
    ingestEconCalendar,      // daily at 15:00 UTC (event context for compute-signal)
    computeSignal,           // every 15 min at :13/:28/:43/:58
    backfillMesAllTimeframes, // event-triggered
  ],
});
