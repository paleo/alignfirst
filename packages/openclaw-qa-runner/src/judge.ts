import Anthropic from "@anthropic-ai/sdk";
import { readJudgeConfig } from "./openclaw-config.js";

let cached: { client: Anthropic; model: string } | null = null;

function getJudge(): { client: Anthropic; model: string } {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — fill in qa/.env.local");
  }
  const judge = readJudgeConfig();
  const model = judge.model.replace(/^anthropic\//, "");
  cached = { client: new Anthropic({ apiKey }), model };
  return cached;
}

export type JudgeUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export type JudgeVerdict = {
  verdict: "pass" | "fail";
  reasoning: string;
  raw: string;
  usage: JudgeUsage;
};

function parseVerdictBody(raw: string): { verdict: "pass" | "fail"; reasoning: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`judge response did not contain a JSON object. raw=${JSON.stringify(raw)}`);
  }
  const slice = raw.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (err) {
    throw new Error(
      `judge JSON parse failed: ${(err as Error).message}. raw=${JSON.stringify(raw)}`,
    );
  }
  const obj = parsed as { verdict?: unknown; reasoning?: unknown };
  if (obj.verdict !== "pass" && obj.verdict !== "fail") {
    throw new Error(`judge verdict invalid: ${JSON.stringify(obj.verdict)}`);
  }
  if (typeof obj.reasoning !== "string") {
    throw new Error(`judge reasoning not a string: ${JSON.stringify(obj.reasoning)}`);
  }
  return { verdict: obj.verdict, reasoning: obj.reasoning };
}

export async function judgeLLM(params: { message: string; rubric: string }): Promise<JudgeVerdict> {
  const { client, model } = getJudge();
  const resp = await client.messages.create({
    model,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `${params.rubric}\n\n---\nMessage under evaluation:\n${params.message}`,
      },
    ],
  });
  const raw = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const body = parseVerdictBody(raw);
  if (!resp.usage) {
    throw new Error("judge response missing usage");
  }
  const usage: JudgeUsage = {
    model,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
  };
  return { ...body, raw, usage };
}
