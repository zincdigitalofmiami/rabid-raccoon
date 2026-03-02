import { NextResponse } from "next/server";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

export const maxDuration = 60;

function buildFallbackNarrative(input: {
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
    const fallbackNarrative = buildFallbackNarrative({
      forecast,
      correlation,
      eventContext,
      risk,
    });

    const prompt = `You are a quantitative trading system monitor for the MES (Micro E-mini S&P 500) futures market.
Synthesize the following real-time data into a 2-3 sentence extremely concise, actionable narrative.
Tone: Institutional, sharp, objective. Use data parameters if relevant.

Data:
- Forecast: ${JSON.stringify(forecast)}
- Correlation: ${JSON.stringify(correlation)}
- Event Context: ${JSON.stringify(eventContext)}
- Risk: ${JSON.stringify(risk)}

Format strictly as:
"MES is [current state based on data]. Alignment is [positive/negative/divergent], [mention event risk if any]. Possible Next Entry Point: [Direction] [Target] (Est. timeframe)."
`;

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({
        narrative: `${fallbackNarrative} AI synthesis is running in fallback mode (missing Anthropic API key).`,
      });
    }

    const { text } = await generateText({
      model: anthropic("claude-3-5-sonnet-latest"),
      prompt,
      temperature: 0.1,
    });

    return NextResponse.json({ narrative: text || fallbackNarrative });
  } catch (error) {
    console.error("AI Synthesis error:", error);
    return NextResponse.json({
      narrative:
        "MES bias is NEUTRAL (confidence pending). Cross-asset alignment or event/risk inputs are still initializing.",
      error: "AI synthesis failed",
    });
  }
}
