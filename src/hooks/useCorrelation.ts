"use client";

import { useState, useEffect, useCallback } from "react";

export interface CorrelationAlignment {
  isAligned: boolean;
  composite: number;
  nq: number;
  vix: number;
  dxy: number;
  cl?: number;
  zn?: number;
  gc?: number;
}

interface CorrelationMeta {
  cadence: "intraday" | "daily" | "unavailable";
  lookbackBars: number;
  observations: number;
  availableSymbols: string[];
  missingSymbols: string[];
  reason: string | null;
}

export interface CorrelationResponse {
  bullish: CorrelationAlignment;
  bearish: CorrelationAlignment;
  meta: CorrelationMeta;
  timestamp: string;
}

export function useCorrelation(pollInterval = 60000) {
  const [data, setData] = useState<CorrelationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCorrelation = useCallback(async () => {
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
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCorrelation();
    const interval = setInterval(fetchCorrelation, pollInterval);
    return () => clearInterval(interval);
  }, [fetchCorrelation, pollInterval]);

  return { data, loading, error };
}
