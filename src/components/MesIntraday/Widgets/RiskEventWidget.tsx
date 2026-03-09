import type { RiskResult } from "@/lib/risk-engine";
import type { EventContext } from "@/lib/event-awareness";
import {
  getEventDisplayLabel,
  getEventDisplayPhase,
  isActiveEventDisplayPhase,
} from "@/lib/event-display";
import type { GprResponse, GprRegime } from "@/hooks/useGpr";

interface Props {
  risk?: RiskResult;
  eventContext?: EventContext;
  gpr?: GprResponse | null;
}

/* ── GPR helpers ───────────────────────────────────────────────────── */

function regimeColor(regime: GprRegime): string {
  switch (regime) {
    case "EXTREME":
      return "text-rose-400";
    case "HIGH":
      return "text-orange-400";
    case "ELEVATED":
      return "text-amber-400";
    case "LOW":
      return "text-emerald-400";
  }
}

function regimeBgColor(regime: GprRegime): string {
  switch (regime) {
    case "EXTREME":
      return "bg-rose-500/10 border-rose-500/30";
    case "HIGH":
      return "bg-orange-500/10 border-orange-500/30";
    case "ELEVATED":
      return "bg-amber-500/10 border-amber-500/30";
    case "LOW":
      return "bg-emerald-500/10 border-emerald-500/30";
  }
}

function MiniSparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 120;
  const h = 28;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="inline-block"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        className="text-amber-500/80"
      />
    </svg>
  );
}

/* ── Component ─────────────────────────────────────────────────────── */

export function RiskEventWidget({ risk, eventContext, gpr }: Props) {
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
  const displayPhase = getEventDisplayPhase(phase);
  const displayLabel = getEventDisplayLabel(eventContext);
  const hasActiveEventRisk = isActiveEventDisplayPhase(phase);
  const phaseBadgeClass =
    displayPhase === "LOCKOUT"
      ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
      : displayPhase === "WATCH"
        ? "bg-amber-500/10 text-amber-300 border-amber-500/20"
        : displayPhase === "REPRICE"
          ? "bg-sky-500/10 text-sky-300 border-sky-500/20"
          : "bg-[var(--zf-control)] text-[var(--zf-text-muted)] border-[var(--zf-border-soft)]";

  return (
    <div className="bg-[var(--zf-surface-elev)] border border-[var(--zf-border)] rounded-xl p-8 flex flex-col justify-between shadow-lg shadow-black/20">
      <div>
        <h3 className="text-[var(--zf-text-muted)] text-sm font-bold tracking-widest uppercase mb-6">
          Execution Risk Grading
        </h3>
        <div className="flex items-center gap-8">
          <div className="text-[6rem] leading-none font-bold text-[var(--zf-gold)] font-mono tracking-tighter shrink-0 drop-shadow-lg">
            {grade}
          </div>
          <div className="space-y-2">
            <div className="text-[var(--zf-text)] font-bold text-xl uppercase tracking-wide">
              {gradeDesc}
            </div>
            <div className="text-[var(--zf-text-muted)] text-sm leading-relaxed">
              {risk
                ? `Analysis based on $${risk.dollarRisk.toFixed(0)} risk target and ${risk.rr.toFixed(1)}x R:R edge.`
                : "Waiting for next trigger configuration."}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-10 pt-8 border-t border-[var(--zf-border-soft)]">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-[var(--zf-text-muted)] text-sm font-bold tracking-widest uppercase relative pr-4">
            Live Catalysts
            {hasActiveEventRisk && (
              <span className="absolute -right-2 top-0 flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
              </span>
            )}
          </h3>
          <span
            className={`px-3 py-1 rounded-sm text-xs font-bold uppercase border tracking-wider ${phaseBadgeClass} ${hasActiveEventRisk ? "animate-pulse" : ""}`}
          >
            {displayPhase}
          </span>
        </div>

        {/* Terminal/Feed style list */}
        <ul className="space-y-4 font-mono text-sm bg-[var(--zf-surface)] p-4 rounded-lg border border-[var(--zf-border-soft)]">
          <li
            className={`flex gap-4 items-start group cursor-default ${hasActiveEventRisk ? "text-orange-400" : "text-[var(--zf-text)]"}`}
          >
            <span className="shrink-0 opacity-50 text-[var(--zf-text-muted)]">
              Live
            </span>
            <span className="font-semibold transition-colors">
              {displayLabel}
            </span>
          </li>
        </ul>
      </div>

      {/* ── GPR Risk Overlay ─────────────────────────────────────── */}
      {gpr && (
        <div className="mt-8 pt-8 border-t border-[var(--zf-border-soft)]">
          <div className="flex justify-between items-center mb-5">
            <h3 className="text-[var(--zf-text-muted)] text-sm font-bold tracking-widest uppercase">
              Geopolitical Risk
            </h3>
            <span
              className={`px-3 py-1 rounded-sm text-xs font-bold uppercase border tracking-wider ${regimeBgColor(gpr.regime)} ${regimeColor(gpr.regime)}`}
            >
              {gpr.regime}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-5">
            <div className="bg-[var(--zf-surface)] rounded-lg border border-[var(--zf-border-soft)] p-3 text-center">
              <div className="text-[var(--zf-text-muted)] text-[10px] font-bold tracking-widest uppercase mb-1">
                GPR Index
              </div>
              <div
                className={`text-lg font-bold font-mono ${regimeColor(gpr.regime)}`}
              >
                {gpr.current.gprd?.toFixed(1) ?? "--"}
              </div>
              {gpr.change1d !== null && (
                <div
                  className={`text-xs font-mono mt-0.5 ${gpr.change1d > 0 ? "text-rose-400" : gpr.change1d < 0 ? "text-emerald-400" : "text-slate-500"}`}
                >
                  {gpr.change1d > 0 ? "+" : ""}
                  {gpr.change1d.toFixed(1)}
                </div>
              )}
            </div>
            <div className="bg-[var(--zf-surface)] rounded-lg border border-[var(--zf-border-soft)] p-3 text-center">
              <div className="text-[var(--zf-text-muted)] text-[10px] font-bold tracking-widest uppercase mb-1">
                Z-Score
              </div>
              <div
                className={`text-lg font-bold font-mono ${
                  gpr.zScore90d !== null && gpr.zScore90d >= 2
                    ? "text-rose-400"
                    : gpr.zScore90d !== null && gpr.zScore90d >= 1
                      ? "text-amber-400"
                      : "text-[var(--zf-text)]"
                }`}
              >
                {gpr.zScore90d !== null ? gpr.zScore90d.toFixed(2) : "--"}
              </div>
              <div className="text-[10px] text-[var(--zf-text-muted)] mt-0.5">
                90-day
              </div>
            </div>
            <div className="bg-[var(--zf-surface)] rounded-lg border border-[var(--zf-border-soft)] p-3 text-center">
              <div className="text-[var(--zf-text-muted)] text-[10px] font-bold tracking-widest uppercase mb-1">
                Percentile
              </div>
              <div className="text-lg font-bold font-mono text-[var(--zf-text)]">
                {gpr.percentile90d !== null
                  ? `${gpr.percentile90d.toFixed(0)}%`
                  : "--"}
              </div>
              <div className="text-[10px] text-[var(--zf-text-muted)] mt-0.5">
                90-day
              </div>
            </div>
          </div>

          {/* Sparkline + MA */}
          <div className="flex items-center justify-between bg-[var(--zf-surface)] rounded-lg border border-[var(--zf-border-soft)] p-3">
            <div className="flex items-center gap-3">
              <MiniSparkline data={gpr.sparkline} />
              <span className="text-[10px] text-[var(--zf-text-muted)] uppercase">
                30-day
              </span>
            </div>
            <div className="flex gap-4 text-xs font-mono text-[var(--zf-text-muted)]">
              <span>
                7d:{" "}
                <span className="text-[var(--zf-text)]">
                  {gpr.ma7?.toFixed(1) ?? "--"}
                </span>
              </span>
              <span>
                30d:{" "}
                <span className="text-[var(--zf-text)]">
                  {gpr.ma30?.toFixed(1) ?? "--"}
                </span>
              </span>
            </div>
          </div>

          {/* Risk cap recommendation */}
          <div
            className={`mt-4 px-3 py-2 rounded-lg border text-xs font-mono ${regimeBgColor(gpr.regime)}`}
          >
            <span className={`font-bold ${regimeColor(gpr.regime)}`}>
              POSITION CAP:
            </span>{" "}
            <span className="text-[var(--zf-text)]">{gpr.riskCap}</span>
          </div>
        </div>
      )}
    </div>
  );
}
