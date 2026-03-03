import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { isMainModule, loadDotEnvFiles, parseArg } from "./ingest-utils";

const FEDERAL_REGISTER_URL =
  "https://www.federalregister.gov/api/v1/documents.json";
const EPU_SERIES_ID = "USEPUINDXD";

interface FederalRegisterResponse {
  results?: Array<{
    document_number?: string;
    title?: string;
    abstract?: string;
    publication_date?: string;
    html_url?: string;
    type?: string;
    presidential_document_type?: string;
    agencies?: Array<{ name?: string }>;
  }>;
}

interface TrumpEffectRow {
  eventDate: Date;
  eventType: string;
  title: string;
  summary: string | null;
  marketImpact: string | null;
  sector: string | null;
  source: string;
  sourceId: string | null;
  sourceUrl: string | null;
  knowledgeTime: Date;
  rowHash: string;
  metadata: Prisma.InputJsonValue;
}

export interface TrumpEffectIngestSummary {
  daysBack: number;
  rowsProcessed: number;
  rowsInserted: number;
  rowsFailed: number;
  federalRegisterRows: number;
  epuRows: number;
  latestEventDate: string | null;
}

interface FredObservation {
  date: string;
  value: string;
}

interface FredResponse {
  observations: FredObservation[];
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function buildHash(parts: Array<string | number | null>): string {
  return createHash("sha256")
    .update(parts.map((p) => String(p ?? "")).join("|"))
    .digest("hex");
}

function parseDaysBack(argDaysBack?: number): number {
  const raw = argDaysBack ?? Number(parseArg("days-back", "3650"));
  if (!Number.isFinite(raw) || raw <= 0)
    throw new Error(`Invalid --days-back '${String(raw)}'`);
  return Math.floor(raw);
}

function inferEventType(title: string, explicitType?: string | null): string {
  const t = `${explicitType || ""} ${title}`.toLowerCase();
  if (t.includes("tariff") || t.includes("duty") || t.includes("trade"))
    return "tariff";
  if (t.includes("executive order") || t.includes("presidential"))
    return "executive_order";
  return "policy";
}

function inferMarketImpact(text: string): string | null {
  const t = text.toLowerCase();
  if (
    /(tariff|sanction|escalat|restriction|ban|retaliat|investigation)/.test(t)
  )
    return "BEARISH";
  if (/(rollback|exempt|pause|deal|agreement|incentive|tax credit)/.test(t))
    return "BULLISH";
  return "NEUTRAL";
}

function normalizeDateOnly(input: Date): Date {
  return new Date(
    Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()),
  );
}

function eventDateFromString(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return normalizeDateOnly(parsed);
}

async function fetchFederalRegisterRows(
  minDate: Date,
): Promise<TrumpEffectRow[]> {
  const url = new URL(FEDERAL_REGISTER_URL);
  url.searchParams.set("per_page", "1000");
  url.searchParams.set("order", "newest");
  url.searchParams.set(
    "conditions[presidential_document_type][]",
    "executive_order",
  );
  url.searchParams.set(
    "conditions[publication_date][gte]",
    minDate.toISOString().slice(0, 10),
  );

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": "RabidRaccoon/warbird-trump-effect" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Federal Register API failed: ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as FederalRegisterResponse;
  const results = json.results || [];
  const rows: TrumpEffectRow[] = [];

  for (const doc of results) {
    const eventDate = eventDateFromString(doc.publication_date);
    if (!eventDate || eventDate < minDate) continue;
    const title = (doc.title || "").trim();
    if (!title) continue;

    const summary = (doc.abstract || "").trim() || null;
    const agencies = (doc.agencies || [])
      .map((a) => a.name)
      .filter(Boolean) as string[];
    const eventType = inferEventType(
      title,
      doc.presidential_document_type || doc.type,
    );
    const impact = inferMarketImpact(`${title} ${summary || ""}`);
    const sourceId = doc.document_number || null;
    const sourceUrl = doc.html_url || null;

    rows.push({
      eventDate,
      eventType,
      title,
      summary,
      marketImpact: impact,
      sector: null,
      source: "federal_register",
      sourceId,
      sourceUrl,
      knowledgeTime: new Date(),
      rowHash: buildHash([
        eventDate.toISOString().slice(0, 10),
        eventType,
        title,
        "federal_register",
        sourceId,
      ]),
      metadata: toJson({
        agencies,
        presidentialDocumentType: doc.presidential_document_type || null,
        documentType: doc.type || null,
      }),
    });
  }

  return rows;
}

async function fetchFredSeries(
  seriesId: string,
  minDate: Date,
): Promise<FredObservation[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error("FRED_API_KEY environment variable is not set");

  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "asc");
  url.searchParams.set("observation_start", minDate.toISOString().slice(0, 10));

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": "RabidRaccoon/warbird-trump-effect" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `FRED API failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`,
    );
  }

  const json = (await response.json()) as FredResponse;
  return (json.observations || []).filter((obs) => obs.value !== ".");
}

async function fetchEpuRows(minDate: Date): Promise<TrumpEffectRow[]> {
  const observations = await fetchFredSeries(EPU_SERIES_ID, minDate);
  const rows: TrumpEffectRow[] = [];

  for (const obs of observations) {
    const eventDate = eventDateFromString(obs.date);
    if (!eventDate || eventDate < minDate) continue;

    const value = Number(obs.value);
    if (!Number.isFinite(value)) continue;

    rows.push({
      eventDate,
      eventType: "policy",
      title: `US EPU Daily Index ${eventDate.toISOString().slice(0, 10)}`,
      summary: `USEPUINDXD=${value.toFixed(3)}`,
      marketImpact:
        value >= 140 ? "BEARISH" : value <= 90 ? "BULLISH" : "NEUTRAL",
      sector: null,
      source: "epu_fred",
      sourceId: `${EPU_SERIES_ID}:${obs.date}`,
      sourceUrl: "https://fred.stlouisfed.org/series/USEPUINDXD",
      knowledgeTime: new Date(),
      rowHash: buildHash([obs.date, EPU_SERIES_ID, value, "epu_fred"]),
      metadata: toJson({
        seriesId: EPU_SERIES_ID,
        value,
        thresholdBearish: 140,
        thresholdBullish: 90,
      }),
    });
  }

  return rows;
}

function toCreateManyRows(
  rows: TrumpEffectRow[],
): Prisma.TrumpEffectCreateManyInput[] {
  return rows.map((row) => ({
    eventDate: row.eventDate,
    eventType: row.eventType,
    title: row.title,
    summary: row.summary,
    marketImpact: row.marketImpact,
    sector: row.sector,
    source: row.source,
    sourceId: row.sourceId,
    sourceUrl: row.sourceUrl,
    knowledgeTime: row.knowledgeTime,
    rowHash: row.rowHash,
    metadata: row.metadata,
  }));
}

export async function runIngestTrumpEffect(opts?: {
  daysBack?: number;
}): Promise<TrumpEffectIngestSummary> {
  loadDotEnvFiles();

  const daysBack = parseDaysBack(opts?.daysBack);
  const minDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  const run = await prisma.ingestionRun.create({
    data: {
      job: "trump-effect",
      status: "RUNNING",
      details: toJson({ daysBack, sources: ["federal_register", "epu_fred"] }),
    },
  });

  try {
    const [fedRows, epuRows] = await Promise.all([
      fetchFederalRegisterRows(minDate),
      fetchEpuRows(minDate),
    ]);

    const allRows = [...fedRows, ...epuRows];
    const payload = toCreateManyRows(allRows);

    const rowsInserted =
      payload.length === 0
        ? 0
        : (
            await prisma.trumpEffect.createMany({
              data: payload,
              skipDuplicates: true,
            })
          ).count;

    const latestEventDate = allRows.length
      ? allRows
          .reduce(
            (latest, row) => (row.eventDate > latest ? row.eventDate : latest),
            allRows[0].eventDate,
          )
          .toISOString()
          .slice(0, 10)
      : null;

    const summary: TrumpEffectIngestSummary = {
      daysBack,
      rowsProcessed: allRows.length,
      rowsInserted,
      rowsFailed: 0,
      federalRegisterRows: fedRows.length,
      epuRows: epuRows.length,
      latestEventDate,
    };

    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        rowsProcessed: summary.rowsProcessed,
        rowsInserted: summary.rowsInserted,
        rowsFailed: summary.rowsFailed,
        details: toJson(summary),
      },
    });

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        details: toJson({ daysBack, error: message }),
      },
    });
    throw error;
  }
}

if (isMainModule(import.meta.url)) {
  runIngestTrumpEffect()
    .then((result) => {
      console.log("[trump-effect] done");
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[trump-effect] failed: ${message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
