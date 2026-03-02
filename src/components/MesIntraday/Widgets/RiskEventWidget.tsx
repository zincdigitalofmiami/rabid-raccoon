import type { RiskResult } from "@/lib/risk-engine";
import type { EventContext } from "@/lib/event-awareness";

interface Props {
  risk?: RiskResult;
  eventContext?: EventContext;
}

export function RiskEventWidget({ risk, eventContext }: Props) {
  const grade = risk?.grade || "--";
  const gradeDesc =
    grade === "A"
      ? "Low Risk"
      : grade === "B"
        ? "Elevated Risk"
        : grade === "C"
          ? "High Risk"
          : "Standby";

  const phase = eventContext?.phase || "CLEAR";
  const isImminent = phase === "IMMINENT" || phase === "APPROACHING";

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 flex flex-col justify-between shadow-lg shadow-black/20">
      <div>
        <h3 className="text-slate-400 text-sm font-bold tracking-widest uppercase mb-6">
          Execution Risk Grading
        </h3>
        <div className="flex items-center gap-8">
          <div className="text-[6rem] leading-none font-bold text-amber-400 font-mono tracking-tighter shrink-0 drop-shadow-lg">
            {grade}
          </div>
          <div className="space-y-2">
            <div className="text-slate-200 font-bold text-xl uppercase tracking-wide">
              {gradeDesc}
            </div>
            <div className="text-slate-500 text-sm leading-relaxed">
              {risk
                ? `Analysis based on $${risk.dollarRisk.toFixed(0)} risk target and ${risk.rr.toFixed(1)}x R:R edge.`
                : "Waiting for next trigger configuration."}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-10 pt-8 border-t border-slate-800/80">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-slate-400 text-sm font-bold tracking-widest uppercase relative pr-4">
            Live Catalysts
            {isImminent && (
              <span className="absolute -right-2 top-0 flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
              </span>
            )}
          </h3>
          <span
            className={`px-3 py-1 rounded-sm text-xs font-bold uppercase border tracking-wider ${isImminent ? "bg-rose-500/10 text-rose-400 border-rose-500/20 animate-pulse" : "bg-slate-800 text-slate-400 border-slate-700"}`}
          >
            {phase}
          </span>
        </div>

        {/* Terminal/Feed style list */}
        <ul className="space-y-4 font-mono text-sm bg-slate-950/50 p-4 rounded-lg border border-slate-800/50">
          <li
            className={`flex gap-4 items-start group cursor-default ${isImminent ? "text-orange-400" : "text-slate-300"}`}
          >
            <span className="shrink-0 opacity-50 text-slate-500">Live</span>
            <span className="font-semibold transition-colors">
              {eventContext?.label ||
                "No active scheduled events or shocks detected."}
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}
