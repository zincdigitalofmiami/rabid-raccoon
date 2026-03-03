import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

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

function clampToMaxSentences(text: string, maxSentences = 3): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const parts = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [normalized];
  return parts
    .slice(0, maxSentences)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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

    const prompt = `You are a quantitative MES (Micro E-mini S&P 500) market analysis engine.
Use neural-pattern reasoning and deep chart-structure interpretation from the structured data below.
Return exactly 2-3 concise institutional sentences (max 3 total), no bullets, no markdown.

Data:
- Forecast: ${JSON.stringify(forecast)}
- Correlation: ${JSON.stringify(correlation)}
- Event Context: ${JSON.stringify(eventContext)}
- Risk: ${JSON.stringify(risk)}

Required content:
1) Current MES directional state and conviction.
2) Cross-asset alignment quality and macro/event risk implication.
3) One actionable next-entry framing with direction + target/zone + expected horizon.
`;

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({
        narrative: `${fallbackNarrative} AI synthesis is running in fallback mode (missing Gemini API key).`,
      });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.1 },
    });

    const aiNarrative = result.response.text();
    const narrative = clampToMaxSentences(aiNarrative, 3) || fallbackNarrative;

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
