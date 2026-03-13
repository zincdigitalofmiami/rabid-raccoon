import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { isMainModule, loadDotEnvFiles, parseArg } from "./ingest-utils";

// Iacovello's site serves XLS (binary). We convert to CSV via Python/xlrd
// (already installed via AutoGluon). No npm xlsx package needed.
const GPR_URL =
  "https://www.matteoiacoviello.com/gpr_files/data_gpr_daily_recent.xls";
const GPR_SOURCE = "caldara_iacoviello";
const GPR_JOB = "gpr-index";
const GPR_RUN_TTL_MINUTES = 180;

interface GprRow {
  eventDate: Date;
  indexName: string;
  value: number;
  source: string;
  sourceUrl: string;
  knowledgeTime: Date;
  rowHash: string;
  metadata: Prisma.InputJsonValue;
}

export interface GprIngestSummary {
  daysBack: number;
  rowsProcessed: number;
  rowsInserted: number;
  rowsFailed: number;
  latestEventDate: string | null;
  sourceUrl: string;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function rowHash(
  eventDate: string,
  indexName: string,
  value: number,
  source: string,
): string {
  return createHash("sha256")
    .update(`${eventDate}|${indexName}|${value}|${source}`)
    .digest("hex");
}

function parseDaysBack(argDaysBack?: number): number {
  const raw = argDaysBack ?? Number(parseArg("days-back", "3650"));
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`Invalid --days-back '${String(raw)}'`);
  }
  return Math.floor(raw);
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  values.push(current.trim());
  return values;
}

function resolveDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) return direct;

  const compact = trimmed.replace(/[^0-9]/g, "");
  if (/^\d{8}$/.test(compact)) {
    const y = Number(compact.slice(0, 4));
    const m = Number(compact.slice(4, 6));
    const d = Number(compact.slice(6, 8));
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function parseGprCsv(csv: string, minDate: Date): GprRow[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const dateIdx = header.findIndex(
    (h) => h === "day" || h === "date" || h === "month" || h === "yyyymm",
  );
  if (dateIdx < 0) {
    throw new Error(
      "GPR CSV is missing a date column (expected day/date/month/yyyymm)",
    );
  }

  const candidateValueCols = [
    "gpr",
    "gprc",
    "gpr_historical",
    "gpr_daily",
    "gpr_index",
    "gpr_act",
  ];
  let valueIdx = header.findIndex((h) => candidateValueCols.includes(h));
  if (valueIdx < 0) {
    valueIdx = header.findIndex(
      (h, i) => i !== dateIdx && !["country", "iso", "region"].includes(h),
    );
  }
  if (valueIdx < 0) {
    throw new Error("GPR CSV does not contain a parseable value column");
  }

  const valueCol = header[valueIdx] || "gpr";
  const rows: GprRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length <= Math.max(dateIdx, valueIdx)) continue;

    const parsedDate = resolveDate(cols[dateIdx]);
    if (!parsedDate || parsedDate < minDate) continue;

    const num = Number(cols[valueIdx]);
    if (!Number.isFinite(num)) continue;

    const eventDateIso = parsedDate.toISOString().slice(0, 10);
    rows.push({
      eventDate: new Date(`${eventDateIso}T00:00:00.000Z`),
      indexName: valueCol.toUpperCase(),
      value: num,
      source: GPR_SOURCE,
      sourceUrl: GPR_URL,
      knowledgeTime: new Date(),
      rowHash: rowHash(eventDateIso, valueCol.toUpperCase(), num, GPR_SOURCE),
      metadata: toJson({
        sourceColumn: valueCol,
        rawDate: cols[dateIdx],
      }),
    });
  }

  return rows;
}

function toCreateManyRows(
  rows: GprRow[],
): Prisma.GeopoliticalRiskCreateManyInput[] {
  return rows.map((row) => ({
    eventDate: row.eventDate,
    indexName: row.indexName,
    value: row.value,
    source: row.source,
    sourceUrl: row.sourceUrl,
    knowledgeTime: row.knowledgeTime,
    rowHash: row.rowHash,
    metadata: row.metadata,
  }));
}

function resolvePythonInterpreters(): string[] {
  const interpreters: string[] = [];
  const venvPython = join(process.cwd(), ".venv-finance", "bin", "python");
  if (existsSync(venvPython)) {
    interpreters.push(venvPython);
  }
  interpreters.push("python3");
  return interpreters;
}

function convertXlsToCsv(xlsBuffer: Buffer): string {
  const tmpPrefix = join(tmpdir(), "rabid-raccoon-gpr-");
  const tmpDir = mkdtempSync(tmpPrefix);
  const xlsPath = join(tmpDir, "gpr.xls");
  try {
    writeFileSync(xlsPath, xlsBuffer);
    const py = String.raw`import csv, io, sys, xlrd
wb = xlrd.open_workbook(sys.argv[1])
ws = wb.sheet_by_index(0)
out = io.StringIO()
w = csv.writer(out)
for r in range(ws.nrows):
    w.writerow([ws.cell_value(r,c) for c in range(ws.ncols)])
sys.stdout.write(out.getvalue())
`;
    const attempts: string[] = [];
    for (const interpreter of resolvePythonInterpreters()) {
      try {
        return execFileSync(interpreter, ["-c", py, xlsPath], {
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push(`${interpreter}: ${message}`);
      }
    }
    throw new Error(
      `no usable Python interpreter for XLS conversion. Tried ${resolvePythonInterpreters().join(", ")}. ` +
        `Errors: ${attempts.join(" | ")}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GPR XLS->CSV conversion failed: ${message}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function runIngestGprIndex(opts?: {
  daysBack?: number;
}): Promise<GprIngestSummary> {
  loadDotEnvFiles();

  const daysBack = parseDaysBack(opts?.daysBack);
  const minDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const staleCutoff = new Date(Date.now() - GPR_RUN_TTL_MINUTES * 60 * 1000);

  await prisma.ingestionRun.updateMany({
    where: {
      job: GPR_JOB,
      status: "RUNNING",
      startedAt: { lt: staleCutoff },
    },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      rowsFailed: 1,
      details: toJson({
        error: "stale RUNNING run auto-closed",
        autoCloseReason: "ttl_exceeded",
        ttlMinutes: GPR_RUN_TTL_MINUTES,
      }),
    },
  });

  const activeRun = await prisma.ingestionRun.findFirst({
    where: { job: GPR_JOB, status: "RUNNING" },
    select: { id: true, startedAt: true },
    orderBy: { startedAt: "desc" },
  });
  if (activeRun) {
    return {
      daysBack,
      rowsProcessed: 0,
      rowsInserted: 0,
      rowsFailed: 0,
      latestEventDate: null,
      sourceUrl: GPR_URL,
    };
  }

  const run = await prisma.ingestionRun.create({
    data: {
      job: GPR_JOB,
      status: "RUNNING",
      details: toJson({ daysBack, sourceUrl: GPR_URL }),
    },
  });

  let summary: GprIngestSummary | null = null;

  try {
    const response = await fetch(GPR_URL, {
      headers: { "User-Agent": "RabidRaccoon/warbird-gpr" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `GPR download failed: ${response.status} ${response.statusText}`,
      );
    }

    const xlsBuffer = Buffer.from(await response.arrayBuffer());
    const csv = convertXlsToCsv(xlsBuffer);
    const parsedRows = parseGprCsv(csv, minDate);
    const payload = toCreateManyRows(parsedRows);

    const inserted =
      payload.length === 0
        ? 0
        : (
            await prisma.geopoliticalRisk.createMany({
              data: payload,
              skipDuplicates: true,
            })
          ).count;

    const latestEventDate = parsedRows.length
      ? parsedRows[parsedRows.length - 1].eventDate.toISOString().slice(0, 10)
      : null;

    summary = {
      daysBack,
      rowsProcessed: parsedRows.length,
      rowsInserted: inserted,
      rowsFailed: 0,
      latestEventDate,
      sourceUrl: GPR_URL,
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
        details: toJson({ daysBack, sourceUrl: GPR_URL, error: message }),
      },
    });
    throw error;
  }
}

if (isMainModule(import.meta.url)) {
  runIngestGprIndex()
    .then((result) => {
      console.log("[gpr-index] done");
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[gpr-index] failed: ${message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
