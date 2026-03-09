import { NextResponse } from "next/server";
import { classifyAIError, generateAIText, isAIAvailable } from "@/lib/ai-provider";

export const maxDuration = 60;

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

    if (!isAIAvailable()) {
      return NextResponse.json(
        { error: "AI synthesis unavailable: AI provider connection is not configured (CLI/OIDC)." },
        { status: 503 },
      );
    }

    const result = await generateAIText(prompt, {
      maxTokens: 300,
      thinkingBudget: 2000, // light thinking for short narrative
    });

    const aiNarrative = result.text;
    const narrative = clampToMaxSentences(aiNarrative, 3);

    if (!narrative) {
      return NextResponse.json(
        { error: "AI synthesis unavailable: model returned empty response." },
        { status: 502 },
      );
    }

    return NextResponse.json({ narrative });
  } catch (error) {
    const classified = classifyAIError(error);
    console.error("AI Synthesis error:", error);
    const status =
      classified.category === "availability" ||
      classified.category === "service_unavailable" ||
      classified.category === "rate_limited" ||
      classified.category === "timeout"
        ? 503
        : 500;

    return NextResponse.json(
      { error: `AI synthesis unavailable: ${classified.publicMessage}` },
      { status },
    );
  }
}
