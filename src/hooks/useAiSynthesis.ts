"use client";

import { useState, useEffect } from "react";

function buildLocalFallback(payload: any): string {
  const forecast = payload?.forecast;
  const correlation = payload?.correlation;
  const eventContext = payload?.eventContext;
  const risk = payload?.risk;

  const direction =
    forecast?.direction === "BULLISH"
      ? "LONG"
      : forecast?.direction === "BEARISH"
        ? "SHORT"
        : "NEUTRAL";

  const confidence =
    typeof forecast?.confidence === "number"
      ? `${Math.round(forecast.confidence)}% confidence`
      : "confidence pending";

  const eventPhase = eventContext?.phase ?? "CLEAR";
  const eventLabel =
    eventContext?.label ?? "no active scheduled macro catalysts";

  const alignment =
    direction === "LONG"
      ? correlation?.bullish
      : direction === "SHORT"
        ? correlation?.bearish
        : correlation?.bullish;

  const alignmentText = alignment
    ? alignment.isAligned
      ? "cross-asset alignment is supportive"
      : "cross-asset alignment is mixed/divergent"
    : "cross-asset alignment data is limited";

  const riskText =
    risk && typeof risk?.rr === "number"
      ? `risk profile is ${risk.grade ?? "N/A"} with ${risk.rr.toFixed(1)}x R:R`
      : "risk profile is still calibrating";

  return `MES bias is ${direction} (${confidence}). ${alignmentText}; event phase is ${eventPhase} (${eventLabel}), and ${riskText}.`;
}

export function useAiSynthesis(payload: any) {
  const [narrative, setNarrative] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only fetch once at least one upstream source is available.
    if (!payload?.forecast && !payload?.correlation && !payload?.eventContext) {
      return;
    }

    const fetchSynthesis = async () => {
      setLoading(true);
      try {
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
        setNarrative(data.narrative || buildLocalFallback(payload));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown");
        setNarrative(buildLocalFallback(payload));
      } finally {
        setLoading(false);
      }
    };

    fetchSynthesis();

    // Poll slower for AI synthesis (e.g. every 2 minutes or on major data change)
    const interval = setInterval(fetchSynthesis, 120_000);
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
