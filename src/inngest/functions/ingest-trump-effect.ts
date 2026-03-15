import { inngest } from "../client";
import { runIngestTrumpEffect } from "../../../scripts/ingest-trump-effect";

/**
 * Trump Effect ingestion (Federal Register + FRED EPU daily).
 * Target table: trump_effect_1d
 * Runs daily at 19:30 UTC.
 */
export const ingestTrumpEffect = inngest.createFunction(
  { id: "ingest-trump-effect", retries: 2 },
  /* PAUSED: { cron: "30 19 * * *" } */ { event: "manual/paused" },
  async ({ step }) => {
    const result = await step.run("ingest-trump-effect", async () =>
      runIngestTrumpEffect({ daysBack: 30 }),
    );
    return { ranAt: new Date().toISOString(), result };
  },
);
