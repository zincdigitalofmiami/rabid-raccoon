import { NextResponse } from "next/server";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { forecast, correlation, eventContext, risk } = body;

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
        narrative:
          "AI Synthesis unavailable: Missing Anthropic API Key. Update env config, passing real data cleanly without it.",
      });
    }

    const { text } = await generateText({
      model: anthropic("claude-3-opus-20240229"), // Maps to Opus-grade processing
      prompt,
      temperature: 0.1,
    });

    return NextResponse.json({ narrative: text || "Analysis unavailable." });
  } catch (error) {
    console.error("AI Synthesis error:", error);
    return NextResponse.json({ error: "AI synthesis failed" }, { status: 500 });
  }
}
