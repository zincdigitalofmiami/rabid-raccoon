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
    <div className="bg-[var(--zf-surface-elev)] border border-[var(--zf-border)] rounded-xl p-10 flex flex-col md:flex-row md:items-center justify-between gap-8 shadow-xl shadow-black/50">
      <div className="flex-1 space-y-3">
        <div className="flex items-center gap-3">
          <span className="flex h-3 w-3 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--zf-cyan)] opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-[var(--zf-cyan-2)]"></span>
          </span>
          <h2 className="text-white font-black tracking-[0.12em] text-2xl md:text-3xl uppercase">
            AI Synthesis Engine
          </h2>
        </div>
        <div className="text-[var(--zf-text)] text-2xl md:text-3xl leading-relaxed min-h-[70px]">
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

      <div className="bg-[var(--zf-surface)] px-10 py-7 rounded-lg border border-[var(--zf-border-soft)] text-center min-w-[340px] shrink-0">
        <div className="text-white text-base font-black uppercase tracking-[0.1em] mb-2">
          Next Extrapolated Target
        </div>
        <div
          className={`text-5xl md:text-6xl font-mono tracking-tight font-black tabular-nums ${direction === "BULLISH" || direction === "LONG" ? "text-[var(--zf-green)]" : "text-red-400"}`}
        >
          {direction === "BULLISH" || direction === "LONG" ? "LONG" : "SHORT"}{" "}
          &gt; {nextTarget}
        </div>
      </div>
    </div>
  );
}
