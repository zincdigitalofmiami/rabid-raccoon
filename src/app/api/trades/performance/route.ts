/**
 * /api/trades/performance — Exact integer performance stats.
 *
 * All numbers as exact counts: "7 out of 10", NOT "64/72ish".
 * Query: ?period=7d (default), 30d, 90d
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PERIODS = ["7d", "30d", "90d"] as const;
type Period = (typeof VALID_PERIODS)[number];

function periodToDays(period: Period): number {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
  }
}

interface ExactCount {
  count: number;
  total: number;
  display: string;
}

function exact(count: number, total: number): ExactCount {
  return {
    count,
    total,
    display: `${count} out of ${total}`,
  };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const periodParam = url.searchParams.get("period") || "7d";
    const period = VALID_PERIODS.includes(periodParam as Period)
      ? (periodParam as Period)
      : "7d";

    const days = periodToDays(period);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Query BHG setups with resolved outcomes
    const setups = await prisma.bhgSetup.findMany({
      where: {
        goTime: { gte: cutoff },
        phase: "GO_FIRED",
        // Only count setups with at least one outcome resolved
        OR: [
          { tp1Hit: { not: null } },
          { tp2Hit: { not: null } },
          { slHit: { not: null } },
        ],
      },
      select: {
        direction: true,
        tp1Hit: true,
        tp2Hit: true,
        slHit: true,
        maxFavorable: true,
        maxAdverse: true,
        goTime: true,
        tp1HitTime: true,
        tp2HitTime: true,
        slHitTime: true,
        pTp1: true,
        pTp2: true,
      },
    });

    const total = setups.length;

    if (total === 0) {
      return NextResponse.json({
        period,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        tp1Hits: exact(0, 0),
        tp2Hits: exact(0, 0),
        slHits: exact(0, 0),
        expired: exact(0, 0),
        avgMFE: null,
        avgMAE: null,
        avgDurationMinutes: null,
        byDirection: {},
        message: "No resolved trades in this period",
      });
    }

    // Count exact outcomes
    const tp1Hits = setups.filter((s) => s.tp1Hit === true).length;
    const tp2Hits = setups.filter((s) => s.tp2Hit === true).length;
    const slHits = setups.filter((s) => s.slHit === true).length;

    // Win = TP1 or TP2 hit, Loss = SL hit without any TP, Expired = no TP and no SL
    const wins = setups.filter(
      (s) => s.tp1Hit === true || s.tp2Hit === true,
    ).length;
    const losses = setups.filter(
      (s) => s.slHit === true && s.tp1Hit !== true && s.tp2Hit !== true,
    ).length;
    const expired = total - wins - losses;

    // MFE / MAE averages
    const mfeValues = setups
      .map((s) => (s.maxFavorable ? Number(s.maxFavorable) : null))
      .filter((v): v is number => v !== null);
    const maeValues = setups
      .map((s) => (s.maxAdverse ? Number(s.maxAdverse) : null))
      .filter((v): v is number => v !== null);

    const avgMFE =
      mfeValues.length > 0
        ? Math.round((mfeValues.reduce((a, b) => a + b, 0) / mfeValues.length) * 10) / 10
        : null;
    const avgMAE =
      maeValues.length > 0
        ? Math.round((maeValues.reduce((a, b) => a + b, 0) / maeValues.length) * 10) / 10
        : null;

    // Average duration (goTime to first TP hit or SL hit)
    const durations: number[] = [];
    for (const s of setups) {
      if (!s.goTime) continue;
      const endTime = s.tp1HitTime ?? s.tp2HitTime ?? s.slHitTime;
      if (!endTime) continue;
      durations.push(
        (endTime.getTime() - s.goTime.getTime()) / 60_000,
      );
    }
    const avgDurationMinutes =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null;

    // By direction
    const byDirection: Record<
      string,
      { total: number; wins: number; losses: number }
    > = {};
    for (const dir of ["BULLISH", "BEARISH"] as const) {
      const dirSetups = setups.filter((s) => s.direction === dir);
      const dirWins = dirSetups.filter(
        (s) => s.tp1Hit === true || s.tp2Hit === true,
      ).length;
      const dirLosses = dirSetups.filter(
        (s) => s.slHit === true && s.tp1Hit !== true && s.tp2Hit !== true,
      ).length;
      if (dirSetups.length > 0) {
        byDirection[dir] = {
          total: dirSetups.length,
          wins: dirWins,
          losses: dirLosses,
        };
      }
    }

    return NextResponse.json({
      period,
      totalTrades: total,
      wins,
      losses,
      tp1Hits: exact(tp1Hits, total),
      tp2Hits: exact(tp2Hits, total),
      slHits: exact(slHits, total),
      expired: exact(expired, total),
      avgMFE,
      avgMAE,
      avgDurationMinutes,
      byDirection,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[trades/performance] GET failed:", message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
