import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/decimal";
import {
  calculateTraditionalPivots,
  pivotLevelsToLines,
  type PivotLine,
} from "@/lib/pivots";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPECTED_LINES_BY_TIMEFRAME = {
  daily: 7,
  weekly: 5,
  monthly: 5,
  yearly: 3,
} as const;

type PivotTimeframe = keyof typeof EXPECTED_LINES_BY_TIMEFRAME;
type PivotCoverageState = "full" | "partial" | "empty";

interface PivotCoverage {
  available: boolean;
  sourceBars: number;
  sourceStart: string | null;
  sourceEnd: string | null;
  lineCount: number;
  expectedLineCount: number;
}

/**
 * GET /api/pivots/mes
 *
 * Returns traditional pivot point levels for MES across four timeframes:
 *   Daily   — from previous trading day's H/L/C
 *   Weekly  — from previous calendar week's H/L/C
 *   Monthly — from previous calendar month's H/L/C
 *   Yearly  — from previous calendar year's H/L/C
 *
 * For a 15m chart, all four timeframes are relevant (matches the Super
 * Pivots Pine Script default: daily ✓ weekly ✓ monthly ✓ yearly ✓).
 *
 * Daily pivots use R1-R3/S1-S3 (7 lines).
 * Weekly pivots use R1-R2/S1-S2 (5 lines).
 * Monthly pivots use R1-R2/S1-S2 (5 lines).
 * Yearly pivots use R1/S1 (3 lines).
 */
export async function GET() {
  try {
    const computedAt = new Date().toISOString();
    const lines: PivotLine[] = [];
    const now = new Date();
    const coverage: Record<PivotTimeframe, PivotCoverage> = {
      daily: {
        available: false,
        sourceBars: 0,
        sourceStart: null,
        sourceEnd: null,
        lineCount: 0,
        expectedLineCount: EXPECTED_LINES_BY_TIMEFRAME.daily,
      },
      weekly: {
        available: false,
        sourceBars: 0,
        sourceStart: null,
        sourceEnd: null,
        lineCount: 0,
        expectedLineCount: EXPECTED_LINES_BY_TIMEFRAME.weekly,
      },
      monthly: {
        available: false,
        sourceBars: 0,
        sourceStart: null,
        sourceEnd: null,
        lineCount: 0,
        expectedLineCount: EXPECTED_LINES_BY_TIMEFRAME.monthly,
      },
      yearly: {
        available: false,
        sourceBars: 0,
        sourceStart: null,
        sourceEnd: null,
        lineCount: 0,
        expectedLineCount: EXPECTED_LINES_BY_TIMEFRAME.yearly,
      },
    };
    const withStart = (items: PivotLine[], start: Date): PivotLine[] => {
      const startSec = Math.floor(start.getTime() / 1000);
      return items.map((line) => ({ ...line, startTime: startSec }));
    };

    // ── Daily Pivots ──────────────────────────────────────────────────────
    // Previous trading day's OHLC from the daily bars table.
    const prevDay = await prisma.mktFuturesMes1d.findFirst({
      where: {
        eventDate: { lt: new Date() },
      },
      orderBy: { eventDate: "desc" },
      select: { high: true, low: true, close: true, eventDate: true },
    });

    if (prevDay) {
      const daily = calculateTraditionalPivots(
        toNum(prevDay.high),
        toNum(prevDay.low),
        toNum(prevDay.close),
      );
      const startOfThisDay = new Date(now);
      startOfThisDay.setUTCHours(0, 0, 0, 0);
      const dailyLines = withStart(pivotLevelsToLines(daily, "D", 3), startOfThisDay);
      lines.push(...dailyLines);
      coverage.daily = {
        available: true,
        sourceBars: 1,
        sourceStart: toIsoDate(prevDay.eventDate),
        sourceEnd: toIsoDate(prevDay.eventDate),
        lineCount: dailyLines.length,
        expectedLineCount: EXPECTED_LINES_BY_TIMEFRAME.daily,
      };
    }

    // ── Weekly Pivots ─────────────────────────────────────────────────────
    // Aggregate previous calendar week's daily bars.
    const dayOfWeek = now.getUTCDay(); // 0=Sun
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setUTCDate(now.getUTCDate() - dayOfWeek);
    startOfThisWeek.setUTCHours(0, 0, 0, 0);

    const startOfLastWeek = new Date(startOfThisWeek);
    startOfLastWeek.setUTCDate(startOfThisWeek.getUTCDate() - 7);

    const weekBars = await prisma.mktFuturesMes1d.findMany({
      where: {
        eventDate: { gte: startOfLastWeek, lt: startOfThisWeek },
      },
      select: { high: true, low: true, close: true, eventDate: true },
      orderBy: { eventDate: "asc" },
    });

    if (weekBars.length > 0) {
      const weekHigh = Math.max(...weekBars.map((b) => toNum(b.high)));
      const weekLow = Math.min(...weekBars.map((b) => toNum(b.low)));
      const weekClose = toNum(weekBars[weekBars.length - 1].close);
      const weekly = calculateTraditionalPivots(weekHigh, weekLow, weekClose);
      const weeklyLines = withStart(pivotLevelsToLines(weekly, "W", 2), startOfThisWeek);
      lines.push(...weeklyLines);
      coverage.weekly = {
        available: true,
        sourceBars: weekBars.length,
        sourceStart: toIsoDate(weekBars[0].eventDate),
        sourceEnd: toIsoDate(weekBars[weekBars.length - 1].eventDate),
        lineCount: weeklyLines.length,
        expectedLineCount: EXPECTED_LINES_BY_TIMEFRAME.weekly,
      };
    }

    // ── Monthly Pivots ────────────────────────────────────────────────────
    const startOfThisMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const startOfLastMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );

    const monthBars = await prisma.mktFuturesMes1d.findMany({
      where: {
        eventDate: { gte: startOfLastMonth, lt: startOfThisMonth },
      },
      select: { high: true, low: true, close: true, eventDate: true },
      orderBy: { eventDate: "asc" },
    });

    if (monthBars.length > 0) {
      const monthHigh = Math.max(...monthBars.map((b) => toNum(b.high)));
      const monthLow = Math.min(...monthBars.map((b) => toNum(b.low)));
      const monthClose = toNum(monthBars[monthBars.length - 1].close);
      const monthly = calculateTraditionalPivots(
        monthHigh,
        monthLow,
        monthClose,
      );
      const monthlyLines = withStart(
        pivotLevelsToLines(monthly, "M", 2),
        startOfThisMonth,
      );
      lines.push(...monthlyLines);
      coverage.monthly = {
        available: true,
        sourceBars: monthBars.length,
        sourceStart: toIsoDate(monthBars[0].eventDate),
        sourceEnd: toIsoDate(monthBars[monthBars.length - 1].eventDate),
        lineCount: monthlyLines.length,
        expectedLineCount: EXPECTED_LINES_BY_TIMEFRAME.monthly,
      };
    }

    // ── Yearly Pivots ─────────────────────────────────────────────────────
    const startOfThisYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const startOfLastYear = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));

    const yearBars = await prisma.mktFuturesMes1d.findMany({
      where: {
        eventDate: { gte: startOfLastYear, lt: startOfThisYear },
      },
      select: { high: true, low: true, close: true, eventDate: true },
      orderBy: { eventDate: "asc" },
    });

    if (yearBars.length > 0) {
      const yearHigh = Math.max(...yearBars.map((b) => toNum(b.high)));
      const yearLow = Math.min(...yearBars.map((b) => toNum(b.low)));
      const yearClose = toNum(yearBars[yearBars.length - 1].close);
      const yearly = calculateTraditionalPivots(yearHigh, yearLow, yearClose);
      const yearlyLines = withStart(pivotLevelsToLines(yearly, "Y", 1), startOfThisYear);
      lines.push(...yearlyLines);
      coverage.yearly = {
        available: true,
        sourceBars: yearBars.length,
        sourceStart: toIsoDate(yearBars[0].eventDate),
        sourceEnd: toIsoDate(yearBars[yearBars.length - 1].eventDate),
        lineCount: yearlyLines.length,
        expectedLineCount: EXPECTED_LINES_BY_TIMEFRAME.yearly,
      };
    }

    const availableTimeframes = Object.values(coverage).filter(
      (entry) => entry.available,
    ).length;
    const totalTimeframes = Object.keys(coverage).length;
    const expectedLineCount = Object.values(EXPECTED_LINES_BY_TIMEFRAME).reduce(
      (acc, count) => acc + count,
      0,
    );
    const status: PivotCoverageState =
      lines.length === 0
        ? "empty"
        : availableTimeframes === totalTimeframes
          ? "full"
          : "partial";

    return NextResponse.json({
      pivots: lines,
      computed: computedAt,
      meta: {
        status,
        source: "mktFuturesMes1d",
        availableTimeframes,
        totalTimeframes,
        lineCount: lines.length,
        expectedLineCount,
        timeframes: coverage,
        updatedAt: computedAt,
      },
    });
  } catch (err) {
    console.error("[pivots/mes] Error:", err);
    return NextResponse.json(
      {
        error: "Failed to compute pivots",
        meta: {
          status: "runtime-failure",
          source: "mktFuturesMes1d",
          updatedAt: new Date().toISOString(),
        },
      },
      { status: 500 },
    );
  }
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
