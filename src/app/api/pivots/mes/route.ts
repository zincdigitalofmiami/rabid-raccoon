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
    const lines: PivotLine[] = [];
    const now = new Date();
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
      select: { high: true, low: true, close: true },
    });

    if (prevDay) {
      const daily = calculateTraditionalPivots(
        toNum(prevDay.high),
        toNum(prevDay.low),
        toNum(prevDay.close),
      );
      const startOfThisDay = new Date(now);
      startOfThisDay.setUTCHours(0, 0, 0, 0);
      lines.push(...withStart(pivotLevelsToLines(daily, "D", 3), startOfThisDay));
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
      lines.push(...withStart(pivotLevelsToLines(weekly, "W", 2), startOfThisWeek));
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
      lines.push(...withStart(pivotLevelsToLines(monthly, "M", 2), startOfThisMonth));
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
      lines.push(...withStart(pivotLevelsToLines(yearly, "Y", 1), startOfThisYear));
    }

    return NextResponse.json({
      pivots: lines,
      computed: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[pivots/mes] Error:", err);
    return NextResponse.json(
      { error: "Failed to compute pivots" },
      { status: 500 },
    );
  }
}
