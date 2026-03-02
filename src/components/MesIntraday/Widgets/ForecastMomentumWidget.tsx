import type { ForecastResponse } from "@/lib/types";
import type { MesSetupsResponse } from "@/hooks/useMesSetups";

interface Props {
  forecast?: ForecastResponse | null;
  setupsData?: MesSetupsResponse | null;
}

export function ForecastMomentumWidget({ forecast, setupsData }: Props) {
  // If we have a mes setup, we can show its targets. Otherwise fallback to forecast levels.
  const leadSetup = setupsData?.setups?.[0];
  const currentPrice = setupsData?.currentPrice ?? 0;

  const primaryTarget =
    leadSetup?.tp1 ??
    forecast?.keyLevels?.resistance?.[0] ??
    forecast?.keyLevels?.support?.[0] ??
    "--";
  let isBullish =
    leadSetup?.direction === "BULLISH" || forecast?.direction === "BULLISH";
  let diff = 0;

  if (typeof primaryTarget === "number" && currentPrice > 0) {
    diff = primaryTarget - currentPrice;
    isBullish = diff > 0;
  }

  return (
    <div className="bg-[var(--zf-surface-elev)] border border-[var(--zf-border)] rounded-xl p-8 flex flex-col justify-between shadow-lg shadow-black/20">
      {/* Top Half: Forecast */}
      <div className="mb-8">
        <h3 className="text-[var(--zf-cyan)] text-sm font-bold tracking-widest uppercase mb-4">
          1H Price Target (Warbird)
        </h3>
        <div className="flex flex-wrap items-baseline gap-3">
          <span
            className={`text-6xl font-mono font-bold tabular-nums tracking-tighter ${isBullish ? "text-[var(--zf-green)]" : "text-red-400"}`}
          >
            {typeof primaryTarget === "number"
              ? primaryTarget.toFixed(2)
              : primaryTarget}
          </span>
          {typeof primaryTarget === "number" && (
            <span
              className={`${isBullish ? "text-[rgba(34,197,94,0.65)]" : "text-red-400/60"} text-xl font-bold tabular-nums tracking-tight`}
            >
              {isBullish ? "▲" : "▼"} {Math.abs(diff).toFixed(2)} pts
            </span>
          )}
        </div>
      </div>

      {/* Bottom Half: Momentum (Placeholder for Lightweight Charts Histogram) */}
      <div className="flex-1 min-h-[160px] relative mt-4 border-t border-[var(--zf-border-soft)] pt-6">
        <div className="absolute top-6 left-0 text-[var(--zf-text-muted)] text-xs font-bold uppercase z-10 pointer-events-none">
          sqzMomentum <span className="opacity-50">| 15M (Real-time)</span>
        </div>
        <div className="w-full h-full bg-[var(--zf-surface)] rounded flex items-center justify-center text-[var(--zf-text-muted)] font-mono text-sm border border-[var(--zf-border-soft)]">
          [ Mount Lightweight Charts Histogram Here ]
        </div>
      </div>
    </div>
  );
}
