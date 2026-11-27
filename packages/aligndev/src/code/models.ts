import { execFile } from "node:child_process";

import type { CodingAgent } from "./coding-agent.js";
import { resolveEfforts } from "./efforts.js";

export const CLAUDE_DEFAULT_MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export const CODEX_DEFAULT_MODELS = ["astra", "sol", "terra", "luna"] as const;
const AGY_MODEL_ALIASES = ["neon", "hydrogen", "argon", "carbon", "flash"] as const;

const MODEL_ALIAS_HELP: Readonly<Record<CatalogAgent, ModelAliasHelp>> = {
  codex: {
    label: "Codex",
    remedy:
      "update the Codex CLI, or set `code.profiles.<name>.models` in the aligndev settings to an " +
      "explicit full model slug and select that value.",
  },
  pi: {
    label: "Pi",
    remedy:
      "update Pi or its model catalogs (`pi update`), check the provider credentials, or pin a " +
      "full `provider/model` selector in the profile's `modelAliases`.",
  },
  agy: {
    label: "Antigravity",
    remedy:
      "update Antigravity, check its sign-in, or pin a full model name in the profile's " +
      "`modelAliases`.",
  },
};
const CATALOG_MAX_BUFFER = 8 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 30_000;
const PI_HEADER = /^provider\s+model\s+context\s+max-out\s+thinking\s+images\s*$/;
// The columns after the model id: context, max-out, thinking, images.
const PI_ROW_TAIL = /^\S+\s+\S+\s+(?:yes|no)\s+(?:yes|no)\s*$/;
const PI_NO_MODELS = /^(?:Warning:\s*)?No models available\. Use \/login to log into a provider\b/;

export type CatalogAgent = "codex" | "pi" | "agy";

interface ModelAliasHelp {
  label: string;
  remedy: string;
}

export interface ModelDiscoveryContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type ModelCatalogRunner = (context: ModelDiscoveryContext) => Promise<CatalogOutput>;

// A catalog command that ran to completion, whatever its exit code.
export interface CatalogOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecutableModelResolver = (
  agent: CodingAgent,
  selectedModel: string | undefined,
  context: ModelDiscoveryContext,
) => Promise<string | undefined>;

export interface CatalogModel {
  id: string;
  provider?: string;
}

interface CatalogEntry {
  aliases: ReadonlySet<string>;
  run: ModelCatalogRunner;
  isSignInRequired(output: CatalogOutput): boolean;
  parse(stdout: string): readonly CatalogModel[];
  prefix: "gpt" | "gemini";
  suffixes: readonly string[];
  toSelector(base: string, models: readonly CatalogModel[]): string;
}

type CatalogCache = WeakMap<NodeJS.ProcessEnv, Map<CatalogAgent, Promise<readonly CatalogModel[]>>>;

export function resolveModels(
  agent: CodingAgent,
  override: readonly string[] | undefined,
  aliases: Readonly<Record<string, string>> = {},
): readonly string[] | undefined {
  if (override !== undefined && override.length > 0) return override;
  switch (agent) {
    case "claude":
      return [...new Set([...CLAUDE_DEFAULT_MODELS, ...Object.keys(aliases)])];
    case "codex":
      return [...new Set([...CODEX_DEFAULT_MODELS, ...Object.keys(aliases)])];
    case "pi":
    case "agy":
      return;
  }
}

export function createExecutableModelResolver(
  runners: Partial<Record<CatalogAgent, ModelCatalogRunner>> = {},
): ExecutableModelResolver {
  const entries = createCatalogEntries(runners);
  const catalogs: CatalogCache = new WeakMap();
  return async (agent, selectedModel, context) => {
    if (selectedModel === undefined) return;
    if (!isCatalogAgent(agent)) return selectedModel;
    const entry = entries[agent];
    if (!entry.aliases.has(selectedModel)) return selectedModel;
    try {
      const models = await loadCatalog(catalogs, agent, entry, context);
      const newest = selectNewestModel(models, selectedModel, entry.prefix, entry.suffixes);
      if (newest === undefined) throw new Error("the model catalog contains no matching model");
      return entry.toSelector(newest.base, newest.models);
    } catch (error) {
      if (error instanceof ModelSignInRequiredError) throw error;
      throw new Error(modelAliasError(agent, selectedModel));
    }
  };
}

// The catalog command reports that the harness has no signed-in account or credentials.
export class ModelSignInRequiredError extends Error {}

function createCatalogEntries(
  runners: Partial<Record<CatalogAgent, ModelCatalogRunner>>,
): Readonly<Record<CatalogAgent, CatalogEntry>> {
  return {
    codex: {
      aliases: new Set<string>(CODEX_DEFAULT_MODELS),
      run:
        runners.codex ??
        ((context) => runModelCatalog("codex", ["debug", "models", "--bundled"], context)),
      isSignInRequired: () => false,
      parse: parseBundledModelSlugs,
      prefix: "gpt",
      suffixes: [],
      toSelector: (base) => base,
    },
    pi: {
      aliases: new Set<string>(CODEX_DEFAULT_MODELS),
      run: runners.pi ?? ((context) => runModelCatalog("pi", ["--list-models"], context)),
      isSignInRequired: isPiCatalogSignInRequired,
      parse: parsePiModelList,
      prefix: "gpt",
      suffixes: [],
      toSelector: toPiSelector,
    },
    agy: {
      aliases: new Set<string>(AGY_MODEL_ALIASES),
      run: runners.agy ?? ((context) => runModelCatalog("agy", ["models"], context)),
      isSignInRequired: isAgyCatalogSignInRequired,
      parse: parseAgyModelList,
      prefix: "gemini",
      suffixes: resolveEfforts("agy", undefined),
      toSelector: (base) => base,
    },
  };
}

function isCatalogAgent(agent: CodingAgent): agent is CatalogAgent {
  return Object.hasOwn(MODEL_ALIAS_HELP, agent);
}

function loadCatalog(
  catalogs: CatalogCache,
  agent: CatalogAgent,
  entry: CatalogEntry,
  context: ModelDiscoveryContext,
): Promise<readonly CatalogModel[]> {
  let byAgent = catalogs.get(context.env);
  if (byAgent === undefined) {
    byAgent = new Map();
    catalogs.set(context.env, byAgent);
  }
  let catalog = byAgent.get(agent);
  if (catalog === undefined) {
    catalog = entry.run(context).then((output) => readCatalog(entry, agent, output));
    byAgent.set(agent, catalog);
  }
  return catalog;
}

function readCatalog(
  entry: CatalogEntry,
  agent: CatalogAgent,
  output: CatalogOutput,
): readonly CatalogModel[] {
  if (entry.isSignInRequired(output)) {
    throw new ModelSignInRequiredError(`${MODEL_ALIAS_HELP[agent].label} requires sign-in.`);
  }
  if (output.exitCode !== 0) throw new Error("The model catalog command failed.");
  return entry.parse(output.stdout);
}

interface NewestModel {
  base: string;
  models: readonly CatalogModel[];
}

function selectNewestModel(
  models: readonly CatalogModel[],
  alias: string,
  prefix: string,
  suffixes: readonly string[],
): NewestModel | undefined {
  const suffix = suffixes.length > 0 ? `(?:-(?:${suffixes.map(escapeRegExp).join("|")}))?` : "";
  const pattern = new RegExp(
    `^(${escapeRegExp(prefix)}-([0-9]+)(?:\\.([0-9]+))?-${escapeRegExp(alias)})${suffix}$`,
  );
  const candidates = models.flatMap((model) => {
    const match = pattern.exec(model.id);
    if (!match) return [];
    return [{ base: match[1], major: Number(match[2]), minor: Number(match[3] ?? 0), model }];
  });
  const newest = candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, candidate) =>
      best === undefined ||
      candidate.major > best.major ||
      (candidate.major === best.major && candidate.minor > best.minor)
        ? candidate
        : best,
    undefined,
  );
  if (newest === undefined) return;
  return {
    base: newest.base,
    models: candidates.filter((c) => c.base === newest.base).map((c) => c.model),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPiSelector(base: string, models: readonly CatalogModel[]): string {
  const providers = [...new Set(models.map((model) => model.provider))];
  const [provider] = providers;
  if (providers.length !== 1 || provider === undefined) {
    throw new Error("Pi lists the model under several providers");
  }
  return `${provider}/${base}`;
}

function modelAliasError(agent: CatalogAgent, alias: string): string {
  const { label, remedy } = MODEL_ALIAS_HELP[agent];
  return (
    `Unable to resolve ${label} model alias ${JSON.stringify(alias)} from its model catalog. ` +
    `To fix it, ${remedy}`
  );
}

export function modelAliasHint(agent: CodingAgent): string | undefined {
  if (!isCatalogAgent(agent)) return;
  const { label, remedy } = MODEL_ALIAS_HELP[agent];
  return `For ${label} aliases, ${remedy}`;
}

export function expandModelAlias(
  model: string | undefined,
  aliases: Readonly<Record<string, string>> = {},
): string | undefined {
  return model !== undefined && Object.hasOwn(aliases, model) ? aliases[model] : model;
}

function parseBundledModelSlugs(output: string): readonly CatalogModel[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Codex returned malformed JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error("Codex returned an unexpected model catalog shape");
  }
  const models: CatalogModel[] = [];
  for (const model of value.models) {
    if (!isRecord(model) || typeof model.slug !== "string") {
      throw new Error("Codex returned an unexpected model catalog shape");
    }
    models.push({ id: model.slug });
  }
  return models;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A successful Pi prints its login guidance instead of the table when no provider has credentials.
function isPiCatalogSignInRequired(output: CatalogOutput): boolean {
  if (output.exitCode !== 0) return false;
  const lines = nonblankLines(output.stdout);
  return (
    !lines.some((line) => PI_HEADER.test(line)) &&
    lines.some((line) => PI_NO_MODELS.test(line.trim()))
  );
}

// Pi pads fixed-width columns, and a model id may contain spaces: fields are read at the header's
// column offsets. Extensions may print output before the header or after the rows: the table ends
// at the first line that is not a row.
function parsePiModelList(output: string): readonly CatalogModel[] {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => PI_HEADER.test(line));
  if (headerIndex === -1) throw new Error("Pi returned a model list without its header");
  const header = lines[headerIndex];
  const modelStart = header.indexOf("model");
  const contextStart = header.indexOf("context");
  const models: CatalogModel[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const model = readPiRow(line, modelStart, contextStart);
    if (model === undefined) break;
    models.push(model);
  }
  if (models.length === 0) throw new Error("Pi returned a model list without rows");
  return models;
}

function readPiRow(
  line: string,
  modelStart: number,
  contextStart: number,
): CatalogModel | undefined {
  const provider = line.slice(0, modelStart).trim();
  const id = line.slice(modelStart, contextStart).trim();
  if (provider.length === 0 || id.length === 0) return;
  if (line[modelStart - 1] !== " " || line[contextStart - 1] !== " ") return;
  if (!PI_ROW_TAIL.test(line.slice(contextStart))) return;
  return { provider, id };
}

function parseAgyModelList(output: string): readonly CatalogModel[] {
  return nonblankLines(output).map((line) => {
    const tab = line.indexOf("\t");
    const id = tab === -1 ? undefined : line.slice(0, tab).trim();
    if (id === undefined || id.length === 0) {
      throw new Error("Antigravity returned a malformed model line");
    }
    return { id };
  });
}

function isAgyCatalogSignInRequired(output: CatalogOutput): boolean {
  return (
    output.exitCode !== 0 &&
    output.stderr
      .split("\n")
      .some((line) => /^Error: (?:Please sign in\b|authentication required)/.test(line.trim()))
  );
}

function nonblankLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function runModelCatalog(
  command: string,
  args: readonly string[],
  context: ModelDiscoveryContext,
): Promise<CatalogOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: context.cwd,
        env: context.env,
        encoding: "utf8",
        maxBuffer: CATALOG_MAX_BUFFER,
        timeout: CATALOG_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        // Spawn failures, timeouts and buffer overflows carry no numeric exit code.
        if (typeof error.code !== "number") {
          reject(new Error("The model catalog command failed."));
          return;
        }
        resolve({ exitCode: error.code, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}
