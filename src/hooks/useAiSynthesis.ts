"use client";

import { useState, useEffect, useRef } from "react";

const AI_SYNTHESIS_REFRESH_MS = 8 * 60 * 60 * 1000;

interface AiSynthesisPayload {
  forecast?: {
    generatedAt?: string;
    direction?: string;
  } | null;
  correlation?: {
    timestamp?: string;
  } | null;
  eventContext?: {
    phase?: string;
    label?: string;
  } | null;
  risk?: {
    grade?: string;
  } | null;
}

export function useAiSynthesis(payload: AiSynthesisPayload) {
  const [narrative, setNarrative] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastFetchAtRef = useRef(0);

  useEffect(() => {
    // Only fetch once at least one upstream source is available.
    if (!payload?.forecast && !payload?.correlation && !payload?.eventContext) {
      return;
    }

    const fetchSynthesis = async (trigger: "effect" | "interval") => {
      const now = Date.now();
      const elapsedMs = now - lastFetchAtRef.current;

      if (lastFetchAtRef.current > 0 && elapsedMs < AI_SYNTHESIS_REFRESH_MS) {
        console.info("[ai-synthesis] skipped (8h cooldown active)", {
          trigger,
          refreshMs: AI_SYNTHESIS_REFRESH_MS,
          elapsedMs,
          nextFetchInMs: AI_SYNTHESIS_REFRESH_MS - elapsedMs,
          at: new Date(now).toISOString(),
        });
        return;
      }

      lastFetchAtRef.current = now;
      setLoading(true);
      try {
        console.info("[ai-synthesis] fetching", {
          trigger,
          refreshMs: AI_SYNTHESIS_REFRESH_MS,
          at: new Date().toISOString(),
          forecastGeneratedAt: payload?.forecast?.generatedAt ?? null,
          correlationTimestamp: payload?.correlation?.timestamp ?? null,
          eventPhase: payload?.eventContext?.phase ?? null,
          riskGrade: payload?.risk?.grade ?? null,
        });
        const res = await fetch("/api/ai/synthesis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(err.error || "AI API failed");
        }
        const data = await res.json();
        if (!data?.narrative || typeof data.narrative !== "string") {
          throw new Error("AI API returned empty narrative");
        }
        setNarrative(data.narrative);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown");
        setNarrative(null);
      } finally {
        setLoading(false);
      }
    };

    void fetchSynthesis("effect");

    const interval = setInterval(() => {
      void fetchSynthesis("interval");
    }, AI_SYNTHESIS_REFRESH_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    // Depend on specific changes rather than the whole object reference
    payload?.forecast?.generatedAt,
    payload?.forecast?.direction,
    payload?.correlation?.timestamp,
    payload?.eventContext?.phase,
    payload?.risk?.grade,
  ]);

  return { narrative, loading, error };
}
