import { execFile } from "node:child_process";

import type { CodingAgent } from "./coding-agent.js";

export const CLAUDE_DEFAULT_MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export const CODEX_DEFAULT_MODELS = ["sol", "terra", "luna"] as const;
export const DEFAULT_MODELS = CLAUDE_DEFAULT_MODELS;

const CODEX_ALIASES = new Set<string>(CODEX_DEFAULT_MODELS);
const CODEX_CATALOG_MAX_BUFFER = 8 * 1024 * 1024;

export function resolveModels(agent: CodingAgent, env: NodeJS.ProcessEnv): readonly string[] {
  const override = (env.ALIGNFIRST_CODE_MODELS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (override.length > 0) return override;
  return agent === "claude" ? CLAUDE_DEFAULT_MODELS : CODEX_DEFAULT_MODELS;
}

export interface ModelDiscoveryContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type ModelCatalogRunner = (context: ModelDiscoveryContext) => Promise<string>;

export type ExecutableModelResolver = (
  agent: CodingAgent,
  selectedModel: string | undefined,
  context: ModelDiscoveryContext,
) => Promise<string | undefined>;

export function createExecutableModelResolver(
  runCatalog: ModelCatalogRunner = runCodexModelCatalog,
): ExecutableModelResolver {
  let cachedSlugs: readonly string[] | undefined;
  return async (agent, selectedModel, context) => {
    if (selectedModel === undefined) return;
    if (agent === "claude" || !CODEX_ALIASES.has(selectedModel)) return selectedModel;
    try {
      cachedSlugs ??= parseBundledModelSlugs(await runCatalog(context));
      const slug = selectNewestCodexModel(cachedSlugs, selectedModel);
      if (slug !== undefined) return slug;
      throw new Error("the bundled catalog contains no matching model");
    } catch (error) {
      throw new Error(codexAliasError(selectedModel, error));
    }
  };
}

export const resolveExecutableModel = createExecutableModelResolver();

export function parseBundledModelSlugs(output: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Codex returned malformed JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error("Codex returned an unexpected model catalog shape");
  }
  const slugs: string[] = [];
  for (const model of value.models) {
    if (!isRecord(model) || typeof model.slug !== "string") {
      throw new Error("Codex returned an unexpected model catalog shape");
    }
    slugs.push(model.slug);
  }
  return slugs;
}

export function selectNewestCodexModel(
  slugs: readonly string[],
  alias: string,
): string | undefined {
  const matches = slugs
    .map((slug) => ({ slug, match: slug.match(/^gpt-([0-9]+)\.([0-9]+)-(sol|terra|luna)$/) }))
    .filter((candidate) => candidate.match?.[3] === alias)
    .sort((a, b) => {
      const major = Number(b.match?.[1]) - Number(a.match?.[1]);
      return major !== 0 ? major : Number(b.match?.[2]) - Number(a.match?.[2]);
    });
  return matches[0]?.slug;
}

function runCodexModelCatalog(context: ModelDiscoveryContext): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "codex",
      ["debug", "models", "--bundled"],
      {
        cwd: context.cwd,
        env: context.env,
        encoding: "utf8",
        maxBuffer: CODEX_CATALOG_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function codexAliasError(alias: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    `Unable to resolve Codex model alias ${JSON.stringify(alias)}: ${detail}. ` +
    "Update the Codex CLI, or set ALIGNFIRST_CODE_MODELS to an explicit full model slug and " +
    "select that value."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
