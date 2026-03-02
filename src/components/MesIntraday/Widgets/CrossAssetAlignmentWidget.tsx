import type {
  CorrelationResponse,
  CorrelationSymbolDetail,
} from "@/hooks/useCorrelation";

// ── Symbol display config ────────────────────────────────────────────────────
const DISPLAY_MAP: Record<string, { ticker: string; inverse: boolean }> = {
  NQ: { ticker: "NQ", inverse: false },
  VX: { ticker: "VIX", inverse: true },
  DX: { ticker: "DXY", inverse: true },
  CL: { ticker: "CL", inverse: false },
  ZN: { ticker: "ZN", inverse: true },
  GC: { ticker: "GC", inverse: false },
};

// Preferred display order
const DISPLAY_ORDER = ["NQ", "VX", "DX", "CL", "ZN", "GC"];

// ── Sub-components ───────────────────────────────────────────────────────────

interface AssetCellProps {
  detail: CorrelationSymbolDetail;
}

function AssetCell({ detail }: AssetCellProps) {
  const config = DISPLAY_MAP[detail.symbol] ?? {
    ticker: detail.symbol,
    inverse: false,
  };
  const r = detail.correlation;
  const rStr = (r > 0 ? "+" : "") + r.toFixed(3);
  const strength =
    Math.abs(r) >= 0.6 ? "Strong" : Math.abs(r) >= 0.3 ? "Moderate" : "Weak";

  const aligned = detail.bullishAligned;
  const colorClass = aligned ? "text-[var(--zf-green)]" : "text-red-400";
  const bgClass = aligned
    ? "bg-[rgba(34,197,94,0.08)] border-[rgba(34,197,94,0.2)]"
    : "bg-red-500/10 border-red-500/20";
  const tagBg = aligned
    ? "bg-[rgba(34,197,94,0.12)] text-[var(--zf-green)] border-[rgba(34,197,94,0.24)]"
    : "bg-red-500/10 text-red-400 border-red-500/20";

  // Rolling trend indicator (30d vs 180d)
  const r30 = detail.rolling30d;
  const r180 = detail.rolling180d;
  let trendArrow = "";
  let trendColor = "text-[var(--zf-text-muted)]";
  if (r30 !== null && r180 !== null) {
    const diff = Math.abs(r30) - Math.abs(r180);
    if (diff > 0.05) {
      trendArrow = "▲";
      trendColor = "text-[rgba(34,197,94,0.7)]";
    } else if (diff < -0.05) {
      trendArrow = "▼";
      trendColor = "text-red-400/70";
    } else {
      trendArrow = "—";
      trendColor = "text-[var(--zf-text-muted)]";
    }
  }

  return (
    <div className={`border rounded-xl p-6 flex flex-col gap-5 ${bgClass}`}>
      <div className="flex justify-between items-start">
        <div>
          <div className="font-black text-4xl text-white tracking-tight font-mono leading-none">
            {config.ticker}
          </div>
          <div className="text-xs text-white/60 uppercase tracking-wider mt-1">
            {detail.label}
            {config.inverse ? " (inverse)" : ""}
          </div>
        </div>
        <div
          className={`px-2.5 py-1 text-[10px] font-black rounded-md border tracking-[0.08em] uppercase ${tagBg}`}
        >
          {aligned ? "Aligned" : "Divergent"}
        </div>
      </div>

      <div>
        <div className="flex items-baseline gap-2">
          <span
            className={`text-5xl font-mono font-black tabular-nums tracking-tight ${colorClass}`}
          >
            {rStr}
          </span>
          {trendArrow && (
            <span
              className={`text-base font-black ${trendColor}`}
              title="30d vs 180d trend"
            >
              {trendArrow}
            </span>
          )}
          <span className="text-xs text-white/50 font-semibold uppercase tracking-wider">
            {strength}
          </span>
        </div>

        <div className="flex gap-3 mt-3 text-[11px] font-mono text-white/70 tabular-nums">
          {detail.rolling30d !== null && (
            <span>
              30D {detail.rolling30d > 0 ? "+" : ""}
              {detail.rolling30d.toFixed(3)}
            </span>
          )}
          {detail.rolling90d !== null && (
            <span>
              90D {detail.rolling90d > 0 ? "+" : ""}
              {detail.rolling90d.toFixed(3)}
            </span>
          )}
        </div>

        <div className="flex gap-4 mt-2 text-[10px] text-white/55 uppercase tracking-wider">
          <span>Wt {(detail.weight * 100).toFixed(0)}%</span>
          <span>Obs {detail.observations}</span>
        </div>
      </div>
    </div>
  );
}

// ── Main widget ──────────────────────────────────────────────────────────────

interface Props {
  correlation?: CorrelationResponse | null;
  direction?: string;
}

export function CrossAssetAlignmentWidget({ correlation, direction }: Props) {
  const isBullishTarget =
    direction === "BULLISH" || direction === "LONG" || !direction;
  const alignment = isBullishTarget
    ? correlation?.bullish
    : correlation?.bearish;
  const isAligned = alignment?.isAligned ?? false;
  const pct = alignment?.composite
    ? (Math.abs(alignment.composite) * 100).toFixed(0)
    : "--";

  // Sort symbols into display order
  const orderedSymbols = (correlation?.symbols ?? []).sort((a, b) => {
    const ai = DISPLAY_ORDER.indexOf(a.symbol);
    const bi = DISPLAY_ORDER.indexOf(b.symbol);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <div className="bg-[var(--zf-surface-elev)] border border-[var(--zf-border)] rounded-xl p-8 xl:col-span-1 shadow-lg shadow-black/20 flex flex-col">
      <div className="flex flex-col gap-5 mb-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="text-white text-4xl md:text-5xl font-black uppercase tracking-[0.12em] leading-none">
              Cross-Asset Engine
            </h3>
            {correlation?.meta && (
              <div className="text-sm text-white/65 mt-3 font-mono">
                {correlation.meta.observations} observations ·{" "}
                {correlation.meta.dateRange?.start} →{" "}
                {correlation.meta.dateRange?.end}
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-white text-6xl font-black tabular-nums leading-none">
              {pct}%
            </div>
            <div
              className={`mt-2 text-xs font-black uppercase tracking-[0.1em] ${
                isAligned ? "text-[var(--zf-green)]" : "text-red-400"
              }`}
            >
              {isBullishTarget ? "Bull" : "Bear"} {isAligned ? "Aligned" : "Divergent"}
            </div>
          </div>
        </div>
        <div className="h-px bg-[var(--zf-border-soft)]" />
      </div>

      {alignment?.details && (
        <p className="text-base text-white/80 mb-6 leading-relaxed">
          {alignment.details}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1">
        {orderedSymbols.map((sym) => (
          <AssetCell key={sym.symbol} detail={sym} />
        ))}
      </div>
    </div>
  );
}
