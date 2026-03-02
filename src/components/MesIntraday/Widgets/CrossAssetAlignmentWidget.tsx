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

  // Color: aligned = green, divergent = rose
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
    <div
      className={`relative border rounded-lg overflow-hidden p-5 flex flex-col justify-between ${bgClass}`}
    >
      {/* Huge faded background r-value */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
        <span
          className={`text-6xl font-bold font-mono opacity-[0.04] tabular-nums ${colorClass}`}
        >
          {rStr}
        </span>
      </div>

      {/* Header row */}
      <div className="flex justify-between items-start z-10 mb-3">
        <div>
          <div className="font-bold text-xl text-[var(--zf-text)] tracking-tight font-mono">
            {config.ticker}
          </div>
          <div className="text-[10px] text-[var(--zf-text-muted)] uppercase tracking-wider mt-0.5">
            {detail.label}
            {config.inverse ? " (inverse)" : ""}
          </div>
        </div>
        <div
          className={`px-2 py-0.5 text-[10px] font-bold rounded border tracking-wide uppercase ${tagBg}`}
        >
          {aligned ? "Aligned" : "Divergent"}
        </div>
      </div>

      {/* Correlation value */}
      <div className="z-10 mt-auto">
        <div className="flex items-baseline gap-2">
          <span
            className={`text-3xl font-mono font-bold tabular-nums tracking-tighter ${colorClass}`}
          >
            r={rStr}
          </span>
          {trendArrow && (
            <span
              className={`text-sm font-bold ${trendColor}`}
              title="30d vs 180d trend"
            >
              {trendArrow}
            </span>
          )}
        </div>

        {/* Rolling values */}
        <div className="flex gap-3 mt-2 text-[10px] font-mono text-[var(--zf-text-muted)] tabular-nums">
          {detail.rolling30d !== null && (
            <span>
              30d: {detail.rolling30d > 0 ? "+" : ""}
              {detail.rolling30d.toFixed(3)}
            </span>
          )}
          {detail.rolling90d !== null && (
            <span>
              90d: {detail.rolling90d > 0 ? "+" : ""}
              {detail.rolling90d.toFixed(3)}
            </span>
          )}
        </div>

        {/* Weight + observations */}
        <div className="flex gap-3 mt-1.5 text-[10px] text-[var(--zf-text-muted)]">
          <span>wt: {(detail.weight * 100).toFixed(0)}%</span>
          <span>obs: {detail.observations}</span>
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
      {/* Header */}
      <div className="flex justify-between items-center mb-5">
        <div>
          <h3 className="text-[var(--zf-text-muted)] text-sm font-bold tracking-widest uppercase">
            Cross-Asset Engine
          </h3>
          {correlation?.meta && (
            <div className="text-[10px] text-[var(--zf-text-muted)] mt-1 font-mono">
              {correlation.meta.observations} obs ·{" "}
              {correlation.meta.dateRange?.start} →{" "}
              {correlation.meta.dateRange?.end}
            </div>
          )}
        </div>
        <span
          className={`text-sm font-bold px-3 py-1 rounded-full border ${
            isAligned
              ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
              : "text-amber-400 bg-amber-500/10 border-amber-500/20"
          }`}
        >
          {pct}% {isBullishTarget ? "Bull" : "Bear"}
        </span>
      </div>

      {/* Details string */}
      {alignment?.details && (
        <p className="text-xs text-[var(--zf-text-muted)] mb-5 leading-relaxed">
          {alignment.details}
        </p>
      )}

      {/* 2x3 Asset grid */}
      <div className="grid grid-cols-2 gap-3 lg:gap-4 flex-1">
        {orderedSymbols.map((sym) => (
          <AssetCell key={sym.symbol} detail={sym} />
        ))}
      </div>
    </div>
  );
}
