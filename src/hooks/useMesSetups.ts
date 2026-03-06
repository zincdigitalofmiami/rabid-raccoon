"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { BhgSetup } from "@/lib/bhg-engine";
import type { FibResult, MeasuredMove } from "@/lib/types";
import type { RiskResult } from "@/lib/risk-engine";
import type { EventContext } from "@/lib/event-awareness";

export interface EnrichedSetup extends BhgSetup {
  risk?: RiskResult;
  pTp1?: number | null;
  pTp2?: number | null;
}

export interface MesSetupsResponse {
  setups: EnrichedSetup[];
  fibResult: FibResult | null;
  currentPrice: number | null;
  measuredMoves?: MeasuredMove[];
  eventContext?: EventContext;
  timestamp: string;
  error?: string;
}

const DEFAULT_POLL_INTERVAL = 60_000;

export function useMesSetups(pollInterval = DEFAULT_POLL_INTERVAL) {
  const [data, setData] = useState<MesSetupsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const fetchSetups = useCallback(async () => {
    if (inFlightRef.current) {
      return inFlightRef.current;
    }

    const request = (async () => {
      try {
        const res = await fetch("/api/setups");
        if (!res.ok) {
          const errData = await res
            .json()
            .catch(() => ({ error: res.statusText }));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        const json: MesSetupsResponse = await res.json();
        setData(json);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    })().finally(() => {
      inFlightRef.current = null;
    });

    inFlightRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    fetchSetups();
    const interval = setInterval(fetchSetups, pollInterval);
    return () => clearInterval(interval);
  }, [fetchSetups, pollInterval]);

  return { data, loading, error, refetch: fetchSetups };
}
