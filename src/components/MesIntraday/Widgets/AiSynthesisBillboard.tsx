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
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 flex flex-col md:flex-row md:items-center justify-between gap-6 shadow-xl shadow-black/50">
      <div className="flex-1 space-y-3">
        <div className="flex items-center gap-3">
          <span className="flex h-3 w-3 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-indigo-500"></span>
          </span>
          <h2 className="text-indigo-400 font-bold tracking-widest text-sm uppercase">
            AI Synthesis Engine
          </h2>
        </div>
        <div className="text-slate-100 text-xl md:text-2xl leading-relaxed min-h-[60px]">
          {loading ? (
            <span className="opacity-50 animate-pulse">
              Model synthesizing multi-asset alignment...
            </span>
          ) : narrative ? (
            <span>{narrative}</span>
          ) : (
            <span className="opacity-50">
              Awaiting market conditions to stabilize...
            </span>
          )}
        </div>
      </div>

      <div className="bg-slate-950 px-8 py-6 rounded-lg border border-slate-800 text-center min-w-[300px] shrink-0">
        <div className="text-slate-400 text-sm font-bold uppercase tracking-wider mb-2">
          Next Extrapolated Target
        </div>
        <div
          className={`text-4xl md:text-5xl font-mono tracking-tight font-bold tabular-nums ${direction === "BULLISH" || direction === "LONG" ? "text-emerald-400" : "text-rose-400"}`}
        >
          {direction === "BULLISH" || direction === "LONG" ? "LONG" : "SHORT"}{" "}
          &gt; {nextTarget}
        </div>
      </div>
    </div>
  );
}
