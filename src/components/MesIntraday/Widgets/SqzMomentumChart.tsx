"use client";

/**
 * SqzMomentumChart — Squeeze Pro momentum histogram (Lightweight Charts v5).
 *
 * Renders the sqzMomentum series from the /api/setups response as a
 * 4-colour histogram matching the TTM Squeeze Pro colour scheme.
 */

import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { SqueezeHistoryBar } from "@/lib/trade-features";

// ── Squeeze Pro state codes (matches computeSqueezeProHistory) ───────────────
const SQZ_STATE_NARROW = 3;  // BB inside inner Keltner  — tightest squeeze
const SQZ_STATE_FIRED  = 4;  // BB outside all Keltners  — momentum released

interface Props {
  history: SqueezeHistoryBar[];
}

/**
 * Bar colour — combines momentum direction with squeeze state.
 * Above zero → cyan family (bullish).   Below zero → red family (bearish).
 * SQZ_STATE_FIRED saturates regardless of direction.
 */
function barColour(mom: number, state: number | null): string {
  const s = state ?? 0;
  if (mom > 0) {
    if (s === SQZ_STATE_FIRED)  return "rgba(0,228,228,1)";     // fired+bullish
    if (s === SQZ_STATE_NARROW) return "rgba(0,200,200,0.85)";  // narrow squeeze
    return "rgba(0,160,200,0.70)";                               // wide/none
  } else {
    if (s === SQZ_STATE_FIRED)  return "rgba(255,80,80,1)";     // fired+bearish
    if (s === SQZ_STATE_NARROW) return "rgba(200,50,50,0.85)";  // narrow squeeze
    return "rgba(140,30,30,0.70)";                               // wide/none
  }
}

export function SqzMomentumChart({ history }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  // ── Mount chart once ─────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(255,255,255,0.3)",
        fontFamily: "Inter, sans-serif",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "transparent" },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      rightPriceScale: {
        borderColor: "transparent",
        autoScale: true,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: "transparent",
        timeVisible: false,
        visible: false,
      },
      crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      base: 0,
    });

    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ autoSize: true });
    });
    resizeObserver.observe(containerRef.current);

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // ── Update data when history changes ─────────────────────────────
  useEffect(() => {
    if (!seriesRef.current || history.length === 0) return;

    const chartData = history
      .filter((b) => b.mom !== null)
      .map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.mom!,
        color: barColour(b.mom!, b.state),
      }));

    if (chartData.length === 0) return;

    seriesRef.current.setData(chartData);
    chartRef.current?.timeScale().fitContent();
  }, [history]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ minHeight: "100%", minWidth: "100%" }}
    />
  );
}
