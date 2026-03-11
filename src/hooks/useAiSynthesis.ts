"use client";

import { useState, useEffect } from "react";

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
