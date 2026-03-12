"use client";

import { useForecast } from "@/hooks/useForecast";
import { useCorrelation } from "@/hooks/useCorrelation";
import { useAiSynthesis } from "@/hooks/useAiSynthesis";
import { useGpr } from "@/hooks/useGpr";
import type { MesSetupsResponse } from "@/hooks/useMesSetups";

import { AiSynthesisBillboard } from "./Widgets/AiSynthesisBillboard";
import { ForecastMomentumWidget } from "./Widgets/ForecastMomentumWidget";
import { CrossAssetAlignmentWidget } from "./Widgets/CrossAssetAlignmentWidget";
import { RiskEventWidget } from "./Widgets/RiskEventWidget";

interface IntelligenceConsoleProps {
  setupsData: MesSetupsResponse | null;
}

export default function IntelligenceConsole({
  setupsData,
}: IntelligenceConsoleProps) {
  const { forecast } = useForecast();
  const { data: correlation } = useCorrelation();
  const { data: gpr } = useGpr();

  const leadSetup = setupsData?.setups?.[0] || null;
  const risk = leadSetup?.risk;
  const eventContext = setupsData?.eventContext;

  // Fetch Vercel AI Synthesis from our route wrapper
  const { narrative, loading: aiLoading } = useAiSynthesis({
    forecast,
    correlation,
    eventContext: eventContext || {
      phase: "CLEAR",
      label: "No Active Pipeline Risks",
    },
    risk,
  });

  // Derive simple next target for Billboard (based on AI forecast or Warbird engine)
  const nextTarget =
    leadSetup?.entry ??
    forecast?.keyLevels?.resistance?.[0] ??
    forecast?.keyLevels?.support?.[0] ??
    "--";
  const dir = leadSetup?.direction ?? forecast?.direction ?? "LONG";

  return (
    <section className="w-full bg-[var(--zf-surface)] p-6 md:p-8">
      <div className="max-w-[1920px] mx-auto space-y-6 md:space-y-8">
        <AiSynthesisBillboard
          narrative={narrative}
          loading={aiLoading}
          nextTarget={nextTarget}
          direction={dir}
        />

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 md:gap-8">
          <ForecastMomentumWidget forecast={forecast} setupsData={setupsData} />
          <CrossAssetAlignmentWidget
            correlation={correlation}
            direction={dir}
          />
          <RiskEventWidget risk={risk} eventContext={eventContext} gpr={gpr} />
        </div>
      </div>
    </section>
  );
}
