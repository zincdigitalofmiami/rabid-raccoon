import { inngest } from "../client";
import { runIngestGprIndex } from "../../../scripts/ingest-gpr-index";

/**
 * Geopolitical risk (GPR) ingestion.
 * Target table: geopolitical_risk_1d
 * Runs daily at 19:00 UTC.
 */
export const ingestGprIndex = inngest.createFunction(
  { id: "ingest-gpr-index", retries: 2 },
  { cron: "0 19 * * *" },
  async ({ step }) => {
    const result = await step.run("ingest-gpr-index", async () =>
      runIngestGprIndex({ daysBack: 30 }),
    );
    return { ranAt: new Date().toISOString(), result };
  },
);
