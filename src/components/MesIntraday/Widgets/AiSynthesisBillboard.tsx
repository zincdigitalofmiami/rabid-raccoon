interface Props {
  narrative?: string | null;
  loading?: boolean;
  nextTarget?: number | string;
  direction?: string;
}

export function AiSynthesisBillboard({
  narrative,
  loading,
  nextTarget,
  direction,
}: Props) {
  return (
    <div className="bg-[var(--zf-surface-elev)] border border-[var(--zf-border)] rounded-xl p-8 flex flex-col md:flex-row md:items-center justify-between gap-6 shadow-xl shadow-black/50">
      <div className="flex-1 space-y-3">
        <div className="flex items-center gap-3">
          <span className="flex h-3 w-3 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--zf-cyan)] opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-[var(--zf-cyan-2)]"></span>
          </span>
          <h2 className="text-[var(--zf-cyan)] font-bold tracking-widest text-sm uppercase">
            AI Synthesis Engine
          </h2>
        </div>
        <div className="text-[var(--zf-text)] text-xl md:text-2xl leading-relaxed min-h-[60px]">
          {loading ? (
            <span className="text-[var(--zf-text-muted)] animate-pulse">
              Model synthesizing multi-asset alignment...
            </span>
          ) : narrative ? (
            <span>{narrative}</span>
          ) : (
            <span className="text-[var(--zf-text-muted)]">
              Awaiting market conditions to stabilize...
            </span>
          )}
        </div>
      </div>

      <div className="bg-[var(--zf-surface)] px-8 py-6 rounded-lg border border-[var(--zf-border-soft)] text-center min-w-[300px] shrink-0">
        <div className="text-[var(--zf-text-muted)] text-sm font-bold uppercase tracking-wider mb-2">
          Next Extrapolated Target
        </div>
        <div
          className={`text-4xl md:text-5xl font-mono tracking-tight font-bold tabular-nums ${direction === "BULLISH" || direction === "LONG" ? "text-[var(--zf-green)]" : "text-red-400"}`}
        >
          {direction === "BULLISH" || direction === "LONG" ? "LONG" : "SHORT"}{" "}
          &gt; {nextTarget}
        </div>
      </div>
    </div>
  );
}
