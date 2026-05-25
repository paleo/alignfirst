import Anthropic from "@anthropic-ai/sdk";
import { extractTaggedBlock } from "./parse-tagged-json.js";

const DEFAULT_JUDGE_MODEL = "anthropic/claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 1024;
const RESULT_TAG = "result-json";

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

export interface JudgeVerdictJson<T> {
  parsed: T;
  raw: string;
  usage: JudgeUsage;
}

export interface JudgeVerdictRaw {
  raw: string;
  usage: JudgeUsage;
}

export async function judgeLLM(params: {
  message: string;
  rubric: string;
  maxTokens?: number;
}): Promise<JudgeVerdict> {
  const prompt = buildVerdictPrompt({ message: params.message, rubric: params.rubric });
  const { raw, usage } = await callAnthropic(prompt, params.maxTokens ?? DEFAULT_MAX_TOKENS);
  const body = extractTaggedBlock(raw, RESULT_TAG);
  const parsed = parseJson(body, raw);
  const obj = parsed as { verdict?: unknown; reasoning?: unknown };
  if (obj.verdict !== "pass" && obj.verdict !== "fail") {
    throw new Error(
      `judge verdict invalid: ${JSON.stringify(obj.verdict)}. raw=${JSON.stringify(raw)}`,
    );
  }
  if (typeof obj.reasoning !== "string") {
    throw new Error(
      `judge reasoning not a string: ${JSON.stringify(obj.reasoning)}. raw=${JSON.stringify(raw)}`,
    );
  }
  return { verdict: obj.verdict, reasoning: obj.reasoning, raw, usage };
}

export async function judgeLLMJson<T>(params: {
  message: string;
  prompt: string;
  returnType: string;
  maxTokens?: number;
}): Promise<JudgeVerdictJson<T>> {
  const prompt = buildJsonPrompt({
    message: params.message,
    prompt: params.prompt,
    returnType: params.returnType,
  });
  const { raw, usage } = await callAnthropic(prompt, params.maxTokens ?? DEFAULT_MAX_TOKENS);
  const body = extractTaggedBlock(raw, RESULT_TAG);
  const parsed = parseJson(body, raw) as T;
  return { parsed, raw, usage };
}

export async function judgeLLMRaw(
  prompt: string,
  opts?: { maxTokens?: number },
): Promise<JudgeVerdictRaw> {
  return await callAnthropic(prompt, opts?.maxTokens ?? DEFAULT_MAX_TOKENS);
}

export function buildVerdictPrompt(params: { message: string; rubric: string }): string {
  return `You are a strict QA judge. Evaluate the message below against the rubric. Return "pass" only when the message satisfies the rubric without violations; otherwise return "fail".

<rubric>
${params.rubric}
</rubric>

<message-to-evaluate>
${params.message}
</message-to-evaluate>

Here is the return type we expect:

<return-type>
interface JudgeResult {
  verdict: "pass" | "fail";
  reasoning?: string; // concise, <=20 words
}
</return-type>

You may write free-form prose first if useful. Then, emit the result JSON value in a \`<${RESULT_TAG}>\` tag.
`;
}

export function buildJsonPrompt(params: {
  message: string;
  prompt: string;
  returnType: string;
}): string {
  return `${params.prompt}

Message under evaluation:

<message-to-evaluate>
${params.message}
</message-to-evaluate>

Here is the return type we expect:

<return-type>
${params.returnType};
</return-type>

You may write free-form prose first if useful. Then, emit the result JSON value in a \`<${RESULT_TAG}>\` tag.
`;
}

async function callAnthropic(
  prompt: string,
  maxTokens: number,
): Promise<{ raw: string; usage: JudgeUsage }> {
  const { client, model, bareModel } = getJudge();
  const resp = await client.messages.create({
    model: bareModel,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  if (!resp.usage) throw new Error("judge response missing usage");
  const usage: JudgeUsage = {
    model,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
  };
  return { raw, usage };
}

function parseJson(body: string, raw: string): unknown {
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(
      `judge JSON parse failed: ${(err as Error).message}. body=${JSON.stringify(body)} raw=${JSON.stringify(raw)}`,
    );
  }
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
