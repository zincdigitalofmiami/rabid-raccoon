"use client";

import { useState, useEffect } from "react";
import type { CorrelationAlignment } from "@/lib/correlation-filter";

interface CorrelationMeta {
  cadence: "intraday" | "daily" | "unavailable";
  lookbackBars: number;
  observations: number;
  availableSymbols: string[];
  missingSymbols: string[];
  reason: string | null;
}

interface CorrelationResponse {
  bullish: CorrelationAlignment;
  bearish: CorrelationAlignment;
  meta: CorrelationMeta;
  timestamp: string;
}

export default function CorrelationTile() {
  const [data, setData] = useState<CorrelationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCorrelation = async () => {
      try {
        const res = await fetch("/api/correlation");
        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const json: CorrelationResponse = await res.json();
        setData(json);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unknown correlation error",
        );
      }
    };
    fetchCorrelation();
    const interval = setInterval(fetchCorrelation, 60_000);
    return () => clearInterval(interval);
  }, []);

  const alignment = data?.bullish;

  return (
    <div className="rounded-xl border border-[var(--zf-border)] bg-[var(--zf-surface-elev)] p-8 flex flex-col">
      <div className="flex items-end justify-between mb-6 gap-3">
        <h3 className="text-white text-4xl font-black uppercase tracking-[0.12em] leading-none">
          Correlations
        </h3>
        {alignment && (
          <span
            className={`text-xs font-black px-3 py-1 rounded-md border uppercase tracking-[0.08em] ${
              alignment.isAligned
                ? "text-[var(--zf-green)] bg-[rgba(34,197,94,0.12)] border-[rgba(34,197,94,0.24)]"
                : "text-red-400 bg-red-400/10 border-red-400/20"
            }`}
          >
            {alignment.isAligned ? "ALIGNED" : "CONFLICT"}
          </span>
        )}
      </div>

      {alignment ? (
        <div className="space-y-4 mt-1">
          {(
            [
              { label: "VIX", value: alignment.vix },
              { label: "NQ", value: alignment.nq },
              { label: "DXY", value: alignment.dxy },
            ] as { label: string; value: number }[]
          ).map(({ label, value }) => {
            const abs = Math.abs(value);
            const color =
              abs < 0.3
                ? "text-[var(--zf-text-muted)]"
                : value > 0
                  ? "text-[var(--zf-green)]"
                  : "text-red-400";
            return (
              <div
                key={label}
                className="flex items-center justify-between border-b border-[var(--zf-border-soft)] pb-2"
              >
                <span className="text-sm font-bold uppercase tracking-wider text-white">
                  {label}
                </span>
                <span
                  className={`text-3xl font-black font-mono tabular-nums ${color}`}
                >
                  {value > 0 ? "+" : ""}
                  {value.toFixed(2)}
                </span>
              </div>
            );
          })}
        </div>
      ) : error ? (
        <div className="text-sm text-red-400/90 mt-1">{error}</div>
      ) : (
        <div className="flex items-center gap-3 mt-2">
          <div className="w-4 h-4 border-2 border-[var(--zf-border)] border-t-white rounded-full animate-spin" />
          <span className="text-sm text-white/70">Loading correlations...</span>
        </div>
      )}

      {alignment && (
        <div className="mt-auto pt-4 text-xs font-mono text-white/65 border-t border-[var(--zf-border-soft)] mt-5">
          composite {alignment.composite.toFixed(3)} · n=
          {data?.meta.observations ?? 0}
        </div>
      )}
    </div>
  );
}
