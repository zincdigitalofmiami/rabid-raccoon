import { useMemo, useState } from "react";
import type {
  CorrelationResponse,
  CorrelationSymbolDetail,
} from "@/hooks/useCorrelation";

type ZlOutlook = "BULLISH" | "NEUTRAL" | "CAUTIOUS" | "BEARISH";

interface ComprehensiveReport {
  tldr: string;
  currentSnapshot: string;
  keyDrivers: string;
  forecasts: string;
  correlations: string;
  technicalOutlook: string;
}

interface IntelligenceDriver {
  label: string;
  outlook: string;
  detail: string;
}

interface Props {
  correlation?: CorrelationResponse | null;
  direction?: string;
}

const DISPLAY_MAP: Record<string, { ticker: string; inverse: boolean }> = {
  NQ: { ticker: "NQ", inverse: false },
  VX: { ticker: "VIX", inverse: true },
  DX: { ticker: "DXY", inverse: true },
  CL: { ticker: "CL", inverse: false },
  ZN: { ticker: "ZN", inverse: true },
  GC: { ticker: "GC", inverse: false },
};

const DISPLAY_ORDER = ["NQ", "VX", "DX", "CL", "ZN", "GC"];

function isTargetAligned(
  detail: CorrelationSymbolDetail,
  isBullishTarget: boolean,
) {
  return isBullishTarget ? detail.bullishAligned : !detail.bullishAligned;
}

function getOutlookColor(outlook: ZlOutlook): string {
  if (outlook === "BULLISH") return "#22C55E";
  if (outlook === "BEARISH") return "#EF4444";
  if (outlook === "CAUTIOUS") return "#F59E0B";
  return "#94A3B8";
}

function ReportSection({
  title,
  content,
  icon,
  color,
}: {
  title: string;
  content: string;
  icon: string;
  color: "slate" | "amber" | "green" | "blue" | "purple";
}) {
  const colorClasses = {
    slate: "border-slate-600 text-slate-400",
    amber: "border-amber-600 text-amber-400",
    green: "border-green-600 text-green-400",
    blue: "border-cyan-600 text-cyan-400",
    purple: "border-violet-600 text-violet-400",
  };

  return (
    <div className={`border-l-2 pl-4 ${colorClasses[color]}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm">{icon}</span>
        <span className="text-xs font-bold uppercase tracking-wider">
          {title}
        </span>
      </div>
      <p className="text-sm md:text-base text-slate-300 leading-relaxed whitespace-pre-line">
        {content}
      </p>
    </div>
  );
}

function ComprehensiveReportSection({
  report,
}: {
  report: ComprehensiveReport;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-6 border-t border-slate-800 pt-6">
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1 h-4 bg-cyan-500 rounded-full" />
          <span className="text-xs font-bold text-cyan-400 uppercase tracking-wider">
            TL;DR
          </span>
        </div>
        <p className="text-base text-slate-300 leading-relaxed">{report.tldr}</p>
      </div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-slate-800/60 hover:bg-slate-700/60 border border-slate-700/50 transition-all text-sm font-medium text-slate-400 hover:text-slate-200"
      >
        <span>{expanded ? "▼" : "▶"}</span>
        <span>{expanded ? "Hide Full Analysis" : "Show Full Market Analysis"}</span>
        <span className="px-2 py-0.5 rounded text-xs bg-violet-500/20 text-violet-400 ml-1">
          AI
        </span>
      </button>
      {expanded && (
        <div className="mt-5 space-y-5 animate-in slide-in-from-top-2 duration-300">
          <ReportSection
            title="Current Market Snapshot"
            content={report.currentSnapshot}
            icon="📊"
            color="slate"
          />
          <ReportSection
            title="Key Drivers Analysis"
            content={report.keyDrivers}
            icon="⚡"
            color="amber"
          />
          <ReportSection
            title="Time-Horizon Forecasts"
            content={report.forecasts}
            icon="📈"
            color="green"
          />
          <ReportSection
            title="Market Connections"
            content={report.correlations}
            icon="🔗"
            color="blue"
          />
          <ReportSection
            title="Key Price Levels"
            content={report.technicalOutlook}
            icon="📉"
            color="purple"
          />
        </div>
      )}
    </div>
  );
}

export function CrossAssetAlignmentWidget({ correlation, direction }: Props) {
  const isBullishTarget =
    direction === "BULLISH" || direction === "LONG" || !direction;
  const alignment = isBullishTarget ? correlation?.bullish : correlation?.bearish;
  const isAligned = alignment?.isAligned ?? false;
  const compositePct =
    alignment?.composite !== undefined
      ? Math.round(Math.abs(alignment.composite) * 100)
      : null;

  const orderedSymbols = useMemo(
    () =>
      (correlation?.symbols ?? []).slice().sort((a, b) => {
        const ai = DISPLAY_ORDER.indexOf(a.symbol);
        const bi = DISPLAY_ORDER.indexOf(b.symbol);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }),
    [correlation?.symbols],
  );

  const strongest = useMemo(
    () =>
      orderedSymbols
        .slice()
        .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation)),
    [orderedSymbols],
  );

  const supportDrivers = strongest
    .filter((detail) => isTargetAligned(detail, isBullishTarget))
    .slice(0, 3);
  const riskDrivers = strongest
    .filter((detail) => !isTargetAligned(detail, isBullishTarget))
    .slice(0, 3);

  const zlOutlook: ZlOutlook = isAligned
    ? isBullishTarget
      ? "BULLISH"
      : "BEARISH"
    : "CAUTIOUS";
  const zlColor = getOutlookColor(zlOutlook);

  const headline = `Cross-Asset ${isBullishTarget ? "Bull" : "Bear"} Regime ${compositePct !== null ? `${compositePct}%` : ""}`.trim();
  const summary =
    alignment?.details ||
    "Cross-asset alignment is still warming up. The basket will populate as enough observations are ingested.";

  const tradingImplication = isAligned
    ? `Cross-asset drivers are confirming this ${isBullishTarget ? "bullish" : "bearish"} setup.`
    : `Cross-asset drivers are split against this ${isBullishTarget ? "bullish" : "bearish"} setup.`;

  const toDriverDetail = (detail: CorrelationSymbolDetail) => {
    const cfg = DISPLAY_MAP[detail.symbol] ?? {
      ticker: detail.symbol,
      inverse: false,
    };
    const relation = detail.correlation >= 0 ? "moves with MES" : "moves opposite MES";
    return `${cfg.ticker} ${detail.correlation >= 0 ? "+" : ""}${detail.correlation.toFixed(3)} (${relation}${cfg.inverse ? ", inverse lens" : ""})`;
  };

  const drivers: IntelligenceDriver[] = [
    ...riskDrivers.map((driver) => ({
      label: DISPLAY_MAP[driver.symbol]?.ticker ?? driver.symbol,
      outlook: "PRESSURE",
      detail: toDriverDetail(driver),
    })),
    ...supportDrivers.map((driver) => ({
      label: DISPLAY_MAP[driver.symbol]?.ticker ?? driver.symbol,
      outlook: "SUPPORTIVE",
      detail: toDriverDetail(driver),
    })),
  ];

  const currentSnapshot =
    alignment?.details ||
    "No stable snapshot yet. Cross-asset matrix is waiting on fresh observations.";

  const keyDrivers = [
    `Support: ${supportDrivers.length > 0 ? supportDrivers.map(toDriverDetail).join(" | ") : "No active support drivers."}`,
    `Risk: ${riskDrivers.length > 0 ? riskDrivers.map(toDriverDetail).join(" | ") : "No active risk drivers."}`,
  ].join("\n");

  const forecasts = `Composite alignment is ${compositePct ?? "--"}%. Signal state is ${isAligned ? "aligned" : "divergent"} for the ${isBullishTarget ? "bullish" : "bearish"} regime.`;

  const correlations =
    orderedSymbols.length > 0
      ? orderedSymbols.map(toDriverDetail).join("\n")
      : "No market connections available yet.";

  const technicalOutlook =
    strongest.length > 0
      ? `Highest transmission is ${toDriverDetail(strongest[0])}. Monitor correlation stability before increasing risk.`
      : "No key transmission leader is available yet.";

  const report: ComprehensiveReport = {
    tldr: summary,
    currentSnapshot,
    keyDrivers,
    forecasts,
    correlations,
    technicalOutlook,
  };

  return (
    <div className="bg-[#0a0a0a] border border-white/5 rounded-2xl p-6 md:p-8 xl:col-span-1">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-1 h-6 rounded-full" style={{ backgroundColor: zlColor }} />
          <h4 className="text-2xl md:text-3xl font-semibold text-white">{headline}</h4>
          <span className="px-2 py-0.5 rounded text-xs font-bold bg-violet-500/20 text-violet-400 border border-violet-500/30">
            AI
          </span>
        </div>
        <span
          className="px-3 py-1.5 rounded text-xs font-bold tracking-wider"
          style={{
            backgroundColor: `${zlColor}20`,
            color: zlColor,
            border: `1px solid ${zlColor}40`,
          }}
        >
          MES {zlOutlook}
        </span>
      </div>

      <p className="text-base text-slate-400 leading-relaxed mb-4">{summary}</p>

      {correlation?.meta && (
        <div className="mb-4 text-xs text-slate-500">
          {correlation.meta.observations} observations |{" "}
          {correlation.meta.dateRange.start} -&gt; {correlation.meta.dateRange.end}
        </div>
      )}

      <div className="mb-4 px-4 py-3 rounded-lg bg-slate-800/50 border border-slate-700/50">
        <span className="text-xs text-slate-500 uppercase tracking-wider">
          What This Means For You
        </span>
        <p className="text-base text-slate-300 mt-1">{tradingImplication}</p>
      </div>

      {drivers.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {drivers.map((driver, idx) => (
            <div key={`${driver.label}-${idx}`} className="flex items-start gap-2 text-sm">
              <span
                className={`px-2 py-0.5 rounded text-xs font-bold shrink-0 ${
                  driver.outlook === "PRESSURE"
                    ? "bg-red-500/20 text-red-400"
                    : "bg-green-500/20 text-green-400"
                }`}
              >
                {driver.outlook === "PRESSURE" ? "Risk" : "Support"}
              </span>
              <span className="text-slate-500">{driver.detail}</span>
            </div>
          ))}
        </div>
      )}

      <ComprehensiveReportSection report={report} />
    </div>
  );
}
