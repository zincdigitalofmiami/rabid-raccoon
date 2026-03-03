import { NextResponse } from "next/server";

export const maxDuration = 60;

function buildNarrative(input: {
  forecast?: any;
  correlation?: any;
  eventContext?: any;
  risk?: any;
}): string {
  const { forecast, correlation, eventContext, risk } = input;

  const direction =
    forecast?.direction === "BULLISH"
      ? "LONG"
      : forecast?.direction === "BEARISH"
        ? "SHORT"
        : "NEUTRAL";

  const confidence =
    typeof forecast?.confidence === "number"
      ? `${Math.round(forecast.confidence)}% confidence`
      : "confidence pending";

  const alignment =
    direction === "LONG"
      ? correlation?.bullish
      : direction === "SHORT"
        ? correlation?.bearish
        : correlation?.bullish;

  const alignmentText = alignment
    ? alignment.isAligned
      ? "cross-asset alignment is supportive"
      : "cross-asset alignment is mixed/divergent"
    : "cross-asset alignment data is limited";

  const eventPhase = eventContext?.phase ?? "CLEAR";
  const eventLabel =
    eventContext?.label ?? "no active scheduled macro catalysts";
  const riskText =
    risk && typeof risk?.rr === "number"
      ? `risk profile is ${risk.grade ?? "N/A"} with ${risk.rr.toFixed(1)}x R:R`
      : "risk profile is still calibrating";

  return `MES bias is ${direction} (${confidence}). ${alignmentText}; event phase is ${eventPhase} (${eventLabel}), and ${riskText}.`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { forecast, correlation, eventContext, risk } = body;
    const narrative = buildNarrative({
      forecast,
      correlation,
      eventContext,
      risk,
    });

    return NextResponse.json({ narrative });
  } catch (error) {
    console.error("AI Synthesis error:", error);
    return NextResponse.json({
      narrative:
        "MES bias is NEUTRAL (confidence pending). Cross-asset alignment or event/risk inputs are still initializing.",
      error: "AI synthesis failed",
    });
  }
}
