"use client";

import { useState, useEffect } from "react";

export function useAiSynthesis(payload: any) {
  const [narrative, setNarrative] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only fetch if we have substantial data
    if (!payload?.forecast && !payload?.correlation) return;

    const fetchSynthesis = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/ai/synthesis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error("AI API failed");
        const data = await res.json();
        setNarrative(data.narrative);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown");
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
    payload?.forecast?.timestamp,
    payload?.correlation?.timestamp,
    payload?.eventContext?.phase,
  ]);

  return { narrative, loading, error };
}
