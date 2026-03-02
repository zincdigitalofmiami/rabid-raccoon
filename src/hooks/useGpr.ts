"use client";

import { useState, useEffect, useCallback } from "react";

// ── Types matching /api/gpr response ─────────────────────────────────────────

export interface GprIndexValues {
  date: string;
  gprd: number | null;
  gprdAct: number | null;
  gprdThreat: number | null;
}

export type GprRegime = "LOW" | "ELEVATED" | "HIGH" | "EXTREME";

export interface GprResponse {
  current: GprIndexValues;
  previous: GprIndexValues | null;
  change1d: number | null;
  ma7: number | null;
  ma30: number | null;
  percentile90d: number | null;
  zScore90d: number | null;
  regime: GprRegime;
  riskCap: string;
  sparkline: number[];
  updatedAt: string;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useGpr(pollInterval = 300_000) {
  const [data, setData] = useState<GprResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchGpr = useCallback(async () => {
    try {
      const res = await fetch("/api/gpr");
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const json: GprResponse = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown GPR error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGpr();
    const interval = setInterval(fetchGpr, pollInterval);
    return () => clearInterval(interval);
  }, [fetchGpr, pollInterval]);

  return { data, loading, error };
}
