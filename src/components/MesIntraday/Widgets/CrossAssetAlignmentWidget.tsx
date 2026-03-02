import type { CorrelationResponse } from "@/hooks/useCorrelation";

interface MiniChartCellProps {
  symbol: string;
  rValue: string;
  isAligned: boolean;
}

function MiniChartCell({ symbol, rValue, isAligned }: MiniChartCellProps) {
  return (
    <div className="relative bg-slate-950/80 border border-slate-800/50 rounded-lg overflow-hidden h-[180px] p-5 flex flex-col">
      {/* Huge Faded Background Number */}
      <div className="absolute inset-0 flex items-center justify-center text-7xl font-bold font-mono opacity-[0.03] text-slate-100 pointer-events-none tabular-nums">
        r={rValue}
      </div>

      {/* Symbol & Tag */}
      <div className="flex justify-between items-start z-10">
        <div className="font-bold text-2xl text-slate-300 tracking-tight">
          {symbol}
        </div>
        <div
          className={`px-2.5 py-1 text-xs font-bold rounded tracking-wide uppercase ${isAligned ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border border-rose-500/20"}`}
        >
          {isAligned ? "Aligned" : "Divergent"}
        </div>
      </div>

      {/* LWC Chart Container Placeholder */}
      <div className="flex-1 mt-3 relative flex items-center justify-center text-slate-800 border-t border-slate-800/50 pt-2">
        <span className="font-mono text-xs opacity-50">
          [ React Area Chart / LWC ]
        </span>
      </div>
    </div>
  );
}

interface Props {
  correlation?: CorrelationResponse | null;
}

export function CrossAssetAlignmentWidget({ correlation }: Props) {
  const alignment = correlation?.bullish; // Primary directional alignment
  const isAligned = alignment?.isAligned ?? false;
  const score = alignment?.composite
    ? (Math.abs(alignment.composite) * 100).toFixed(0)
    : "--";

  // Safely grab correlation values protecting against null/undefined
  const getRValue = (val?: number) =>
    val ? (val > 0 ? "+" : "") + val.toFixed(2) : "?";

  // Decide alignment state naively for individual assets based on threshold, or rely on root boolean
  const isIndividualAligned = (val?: number) =>
    val !== undefined ? Math.abs(val) > 0.6 : false;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 xl:col-span-1 shadow-lg shadow-black/20 flex flex-col">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-slate-400 text-sm font-bold tracking-widest uppercase">
          Cross-Asset Engine
        </h3>
        <span
          className={`text-sm font-bold px-3 py-1 rounded-full border ${isAligned ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" : "text-amber-400 bg-amber-500/10 border-amber-500/20"}`}
        >
          {score}% Aligned
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:gap-6 flex-1">
        <MiniChartCell
          symbol="NQ1!"
          rValue={getRValue(alignment?.nq)}
          isAligned={isIndividualAligned(alignment?.nq)}
        />
        <MiniChartCell
          symbol="VIX"
          rValue={getRValue(alignment?.vix)}
          isAligned={isIndividualAligned(alignment?.vix)}
        />
        <MiniChartCell
          symbol="DXY"
          rValue={getRValue(alignment?.dxy)}
          isAligned={isIndividualAligned(alignment?.dxy)}
        />
        <MiniChartCell
          symbol="GC1!"
          rValue={getRValue(alignment?.gc)}
          isAligned={isIndividualAligned(alignment?.gc)}
        />
      </div>
    </div>
  );
}
