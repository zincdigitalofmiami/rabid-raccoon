import { inngest } from "../client";
import { prisma } from "../../lib/prisma";
import { runIngestEconCalendar } from "../../lib/ingest/econ-calendar";

const RELEASE_BATCHES: Array<{ id: string; releaseIds: number[] }> = [
  { id: "tier1-fomc-nfp-cpi-pce", releaseIds: [101, 50, 10, 53] },
  {
    id: "tier2-ppi-retail-gdp-claims-jolts",
    releaseIds: [46, 9, 21, 180, 192],
  },
  { id: "tier3-sentiment-durables-housing", releaseIds: [54, 95, 27, 97] },
  {
    id: "tier3-adp-indprod-trade-construction",
    releaseIds: [194, 13, 51, 229],
  },
];

const DAILY_RATES_WINDOWS: Array<{
  id: string;
  startDateStr: string;
  endDateStr?: string;
}> = [
  {
    id: "daily-rates-2020-2021",
    startDateStr: "2020-01-01",
    endDateStr: "2021-12-31",
  },
  {
    id: "daily-rates-2022-2023",
    startDateStr: "2022-01-01",
    endDateStr: "2023-12-31",
  },
  { id: "daily-rates-2024-now", startDateStr: "2024-01-01" },
];

/**
 * Economic calendar releases + daily Treasury rates + earnings.
 * Target tables: econ_calendar, macro_reports_1d
 * One step per release tier + one per rates window + one for earnings.
 * Runs daily at 07:35 UTC.
 */
export const ingestEconCalendar = inngest.createFunction(
  { id: "ingest-econ-calendar", retries: 2 },
  { cron: "0 15 * * *" },
  async ({ step }) => {
    const run = await step.run("create-ingestion-run", async () => {
      const record = await prisma.ingestionRun.create({
        data: {
          job: "ingest-econ-calendar",
          status: "RUNNING",
          details: {
            releaseBatches: RELEASE_BATCHES.length,
            ratesWindows: DAILY_RATES_WINDOWS.length,
            includesEarnings: true,
          },
        },
      });
      return { id: record.id };
    });

    try {
      const releaseResults: Array<{
        batchId: string;
        result: Awaited<ReturnType<typeof runIngestEconCalendar>>;
      }> = [];
      const ratesResults: Array<{
        batchId: string;
        result: Awaited<ReturnType<typeof runIngestEconCalendar>>;
      }> = [];

      // Release tiers (FOMC, NFP, CPI, PPI, etc.)
      for (const batch of RELEASE_BATCHES) {
        const result = await step.run(`econ-calendar-${batch.id}`, async () =>
          runIngestEconCalendar({
            startDateStr: "2020-01-01",
            releaseIds: batch.releaseIds,
            includeEarnings: false,
            continueOnError: true,
          }),
        );
        releaseResults.push({ batchId: batch.id, result });
      }

      // Daily Treasury rates
      for (const window of DAILY_RATES_WINDOWS) {
        const result = await step.run(`econ-calendar-${window.id}`, async () =>
          runIngestEconCalendar({
            startDateStr: window.startDateStr,
            endDateStr: window.endDateStr,
            releaseIds: [18],
            includeEarnings: false,
            continueOnError: true,
          }),
        );
        ratesResults.push({ batchId: window.id, result });
      }

      // Earnings
      const earningsResult = await step.run(
        "econ-calendar-earnings",
        async () =>
          runIngestEconCalendar({
            startDateStr: "2020-01-01",
            releaseIds: [],
            includeEarnings: true,
            continueOnError: true,
          }),
      );

      await step.run("update-ingestion-run", async () => {
        await prisma.ingestionRun.update({
          where: { id: run.id },
          data: {
            status: "COMPLETED",
            finishedAt: new Date(),
            details: JSON.parse(
              JSON.stringify({ releaseResults, ratesResults, earningsResult }),
            ),
          },
        });
      });

      return {
        ranAt: new Date().toISOString(),
        releaseResults,
        ratesResults,
        earningsResult,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await prisma.ingestionRun.update({
          where: { id: run.id },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            details: { error: message },
          },
        });
      } catch (e) {
        console.error("[econ-calendar] IngestionRun update failed:", e);
      }
      throw error;
    }
  },
);
