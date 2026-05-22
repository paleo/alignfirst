import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_JUDGE_MODEL = "anthropic/claude-haiku-4-5";

let cached: { client: Anthropic; model: string; bareModel: string } | undefined;

export interface JudgeUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface JudgeVerdict {
  verdict: "pass" | "fail";
  reasoning: string;
  raw: string;
  usage: JudgeUsage;
}

export async function judgeLLM(params: { message: string; rubric: string }): Promise<JudgeVerdict> {
  const { client, model, bareModel } = getJudge();
  const resp = await client.messages.create({
    model: bareModel,
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
  if (!resp.usage) throw new Error("judge response missing usage");
  const usage: JudgeUsage = {
    model,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
  };
  return { ...body, raw, usage };
}

function getJudge(): { client: Anthropic; model: string; bareModel: string } {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set — fill in qa/.env.local");
  const model = process.env.QA_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  const bareModel = parseAnthropicModelRef(model);
  cached = { client: new Anthropic({ apiKey }), model, bareModel };
  return cached;
}

function parseAnthropicModelRef(ref: string): string {
  const slash = ref.indexOf("/");
  if (slash < 0) {
    throw new Error(
      `QA_JUDGE_MODEL must be a LiteLLM-style "provider/model" reference (e.g. "anthropic/claude-haiku-4-5"); got ${JSON.stringify(ref)}`,
    );
  }
  const provider = ref.slice(0, slash);
  const name = ref.slice(slash + 1);
  if (provider !== "anthropic") {
    throw new Error(
      `QA_JUDGE_MODEL provider ${JSON.stringify(provider)} is not supported; only "anthropic/" is currently wired up`,
    );
  }
  if (!name) throw new Error(`QA_JUDGE_MODEL model name is empty after the "${provider}/" prefix`);
  return name;
}

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
