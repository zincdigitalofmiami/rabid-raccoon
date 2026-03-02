import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const revalidate = 1800;

/**
 * GET /api/gpr — Returns latest GPR data with historical context.
 *
 * Response shape:
 * {
 *   current:   { date, gprd, gprdAct, gprdThreat },
 *   previous:  { date, gprd, gprdAct, gprdThreat },
 *   change1d:  number,
 *   ma7:       number | null,
 *   ma30:      number | null,
 *   percentile90d: number | null,
 *   zScore90d: number | null,
 *   regime:    "LOW" | "ELEVATED" | "HIGH" | "EXTREME",
 *   riskCap:   string,
 *   sparkline: number[],   // last 30 days of GPRD
 *   updatedAt: string,
 * }
 */
export async function GET() {
  try {
    // Latest 2 days of GPRD for current + change
    const latestGprd = await prisma.geopoliticalRisk.findMany({
      where: { indexName: "GPRD" },
      orderBy: { eventDate: "desc" },
      take: 2,
    });

    if (latestGprd.length === 0) {
      return NextResponse.json(
        { error: "No GPR data available" },
        { status: 404 },
      );
    }

    const currentDate = latestGprd[0].eventDate;

    // Get all 3 indexes for the current day
    const currentDay = await prisma.geopoliticalRisk.findMany({
      where: { eventDate: currentDate },
      orderBy: { indexName: "asc" },
    });

    const prevDate = latestGprd[1]?.eventDate ?? null;
    const prevDay = prevDate
      ? await prisma.geopoliticalRisk.findMany({
          where: { eventDate: prevDate },
          orderBy: { indexName: "asc" },
        })
      : [];

    // Last 90 days of GPRD for stats
    const ninetyDaysAgo = new Date(
      currentDate.getTime() - 90 * 24 * 60 * 60 * 1000,
    );
    const hist90 = await prisma.geopoliticalRisk.findMany({
      where: {
        indexName: "GPRD",
        eventDate: { gte: ninetyDaysAgo },
      },
      orderBy: { eventDate: "asc" },
      select: { eventDate: true, value: true },
    });

    const vals = hist90.map((r) => Number(r.value));

    // Compute stats
    const mean =
      vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const std =
      vals.length > 1 && mean !== null
        ? Math.sqrt(
            vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
              (vals.length - 1),
          )
        : null;

    const currentGprd = Number(latestGprd[0].value);
    const zScore90d =
      mean !== null && std !== null && std > 0
        ? (currentGprd - mean) / std
        : null;

    // Percentile
    const sorted = [...vals].sort((a, b) => a - b);
    const percentile90d =
      sorted.length > 0
        ? (sorted.filter((v) => v <= currentGprd).length / sorted.length) * 100
        : null;

    // Moving averages from last 30 values
    const last30 = vals.slice(-30);
    const last7 = vals.slice(-7);
    const ma30 =
      last30.length > 0
        ? last30.reduce((a, b) => a + b, 0) / last30.length
        : null;
    const ma7 =
      last7.length > 0 ? last7.reduce((a, b) => a + b, 0) / last7.length : null;

    // Regime classification
    const regime = classifyRegime(currentGprd, zScore90d);

    // Risk cap recommendation
    const riskCap = getRiskCap(regime);

    // Build index maps
    const toIndexMap = (
      rows: typeof currentDay,
    ): Record<string, number | null> => {
      const map: Record<string, number | null> = {
        gprd: null,
        gprdAct: null,
        gprdThreat: null,
      };
      for (const r of rows) {
        if (r.indexName === "GPRD") map.gprd = Number(r.value);
        if (r.indexName === "GPRD_ACT") map.gprdAct = Number(r.value);
        if (r.indexName === "GPRD_THREAT") map.gprdThreat = Number(r.value);
      }
      return map;
    };

    const change1d =
      latestGprd.length >= 2
        ? Number(latestGprd[0].value) - Number(latestGprd[1].value)
        : null;

    return NextResponse.json({
      current: {
        date: currentDate.toISOString().slice(0, 10),
        ...toIndexMap(currentDay),
      },
      previous: prevDate
        ? {
            date: prevDate.toISOString().slice(0, 10),
            ...toIndexMap(prevDay),
          }
        : null,
      change1d,
      ma7: ma7 !== null ? round2(ma7) : null,
      ma30: ma30 !== null ? round2(ma30) : null,
      percentile90d: percentile90d !== null ? round2(percentile90d) : null,
      zScore90d: zScore90d !== null ? round2(zScore90d) : null,
      regime,
      riskCap,
      sparkline: last30.map((v) => round2(v)),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[/api/gpr] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch GPR data" },
      { status: 500 },
    );
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type GprRegime = "LOW" | "ELEVATED" | "HIGH" | "EXTREME";

function classifyRegime(gprd: number, zScore: number | null): GprRegime {
  // Absolute thresholds based on GPR index (1985-2019 = 100 baseline)
  if (gprd >= 300 || (zScore !== null && zScore >= 2.5)) return "EXTREME";
  if (gprd >= 150 || (zScore !== null && zScore >= 1.5)) return "HIGH";
  if (gprd >= 100 || (zScore !== null && zScore >= 0.5)) return "ELEVATED";
  return "LOW";
}

function getRiskCap(regime: GprRegime): string {
  switch (regime) {
    case "EXTREME":
      return "25% max position — extreme geopolitical stress";
    case "HIGH":
      return "50% max position — elevated geopolitical risk";
    case "ELEVATED":
      return "75% max position — monitor developments";
    case "LOW":
      return "100% — normal conditions";
  }
}
