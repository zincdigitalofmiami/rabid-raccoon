import type { ForecastResponse } from "@/lib/types";
import type { MesSetupsResponse } from "@/hooks/useMesSetups";
import { SqzMomentumChart } from "./SqzMomentumChart";

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
    <div className="bg-[var(--zf-surface-elev)] border border-[var(--zf-border)] rounded-xl p-10 flex flex-col justify-between shadow-lg shadow-black/20">
      {/* Top Half: Forecast */}
      <div className="mb-8">
        <h3 className="text-white text-2xl md:text-3xl font-black tracking-[0.1em] uppercase mb-5 leading-none">
          1H Price Target (Warbird)
        </h3>
        <div className="flex flex-wrap items-baseline gap-3">
          <span
            className={`text-7xl font-mono font-black tabular-nums tracking-tighter ${isBullish ? "text-[var(--zf-green)]" : "text-red-400"}`}
          >
            {typeof primaryTarget === "number"
              ? primaryTarget.toFixed(2)
              : primaryTarget}
          </span>
          {typeof primaryTarget === "number" && (
            <span
              className={`${isBullish ? "text-[rgba(34,197,94,0.65)]" : "text-red-400/60"} text-2xl font-black tabular-nums tracking-tight`}
            >
              {isBullish ? "▲" : "▼"} {Math.abs(diff).toFixed(2)} pts
            </span>
          )}
        </div>
      </div>

      {/* Bottom Half: sqzMomentum histogram (Squeeze Pro, 15M real-time) */}
      <div className="flex-1 min-h-[160px] relative mt-4 border-t border-[var(--zf-border-soft)] pt-6">
        <div className="absolute top-6 left-0 text-[var(--zf-text-muted)] text-xs font-bold uppercase z-10 pointer-events-none">
          sqzMomentum <span className="opacity-50">| 15M (Real-time)</span>
        </div>
        <div className="w-full h-full" style={{ minHeight: 140 }}>
          <SqzMomentumChart history={setupsData?.sqzHistory ?? []} />
        </div>
      </div>
    </div>
  );
}
