import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import type { CodingAgent } from "./coding-agent.js";
import { resolveEfforts } from "./efforts.js";

export const CLAUDE_DEFAULT_MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export const CODEX_DEFAULT_MODELS = ["astra", "sol", "terra", "luna"] as const;
const AGY_MODEL_ALIASES = ["carbon", "neon", "hydrogen", "flash"] as const;

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
const CATALOG_KILL_GRACE_MS = 5_000;
const PI_REQUEST_ID = "aligndev-models";
const PI_DIALOG_METHODS: ReadonlySet<unknown> = new Set(["select", "confirm", "input", "editor"]);
const LF = 0x0a;

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

interface CatalogCommand {
  name: string;
  args: readonly string[];
  // Written to stdin, which stays open until `readLine` asks to end it. Without input, stdin closes
  // at once.
  input?: string;
  readLine?(line: string): CatalogLineAction | undefined;
}

// `endInput` closes the command's stdin; an error fails the command.
type CatalogLineAction = "endInput" | Error;

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
      if (error instanceof ModelSignInRequiredError || error instanceof PiStartupDialogError) {
        throw error;
      }
      throw new Error(modelAliasError(agent, selectedModel));
    }
  };
}

// The catalog command reports that the harness has no signed-in account or credentials.
export class ModelSignInRequiredError extends Error {}

// A Pi extension opened a dialog that blocks Pi before it serves its catalog. The CLI renders a fixed
// diagnostic from the type.
export class PiStartupDialogError extends Error {}

function createCatalogEntries(
  runners: Partial<Record<CatalogAgent, ModelCatalogRunner>>,
): Readonly<Record<CatalogAgent, CatalogEntry>> {
  return {
    codex: {
      aliases: new Set<string>(CODEX_DEFAULT_MODELS),
      run:
        runners.codex ??
        ((context) =>
          runCatalogCommand({ name: "codex", args: ["debug", "models", "--bundled"] }, context)),
      isSignInRequired: () => false,
      parse: parseBundledModelSlugs,
      prefix: "gpt",
      suffixes: [],
      toSelector: (base) => base,
    },
    pi: {
      aliases: new Set<string>(CODEX_DEFAULT_MODELS),
      run: runners.pi ?? runPiModelCatalog,
      isSignInRequired: isPiCatalogSignInRequired,
      parse: parsePiModels,
      prefix: "gpt",
      suffixes: [],
      toSelector: toPiSelector,
    },
    agy: {
      aliases: new Set<string>(AGY_MODEL_ALIASES),
      run:
        runners.agy ?? ((context) => runCatalogCommand({ name: "agy", args: ["models"] }, context)),
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

// Pi answers with an empty list when no provider has credentials.
function isPiCatalogSignInRequired(output: CatalogOutput): boolean {
  return output.exitCode === 0 && readPiModels(output.stdout)?.length === 0;
}

function parsePiModels(stdout: string): readonly CatalogModel[] {
  const models = readPiModels(stdout);
  if (models === undefined) throw new Error("Pi returned no model list");
  return models;
}

// The RPC response to `get_available_models`, among the other protocol records of stdout.
function readPiModels(stdout: string): CatalogModel[] | undefined {
  const response = findPiResponse(stdout);
  if (response?.success !== true || !isRecord(response.data)) return;
  const { models } = response.data;
  if (!Array.isArray(models)) return;
  const result: CatalogModel[] = [];
  for (const model of models) {
    if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") {
      return;
    }
    result.push({ provider: model.provider, id: model.id });
  }
  return result;
}

// Only LF-terminated lines are records: the text after the last LF is dropped.
function findPiResponse(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split("\n").slice(0, -1)) {
    const record = parsePiRecord(line);
    if (record !== undefined && isPiCatalogResponse(record)) return record;
  }
}

function parsePiRecord(line: string): Record<string, unknown> | undefined {
  try {
    const record: unknown = JSON.parse(line);
    return isRecord(record) ? record : undefined;
  } catch {
    return;
  }
}

function isPiCatalogResponse(record: Record<string, unknown>): boolean {
  return record.type === "response" && record.id === PI_REQUEST_ID;
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

// A catalog command runs under a deadline and an output limit in bytes. A failure stops buffering
// and settles once the process has exited.
function runCatalogCommand(
  command: CatalogCommand,
  context: ModelDiscoveryContext,
): Promise<CatalogOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.name, command.args, { cwd: context.cwd, env: context.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failing = false;
    const fail = (error = catalogFailure()): void => {
      if (failing) return;
      failing = true;
      clearTimeout(deadline);
      stopChild(child, () => reject(error));
    };
    const collect = (chunks: Buffer[], chunk: Buffer): boolean => {
      if (failing) return false;
      bytes += chunk.length;
      if (bytes > CATALOG_MAX_BUFFER) fail();
      else chunks.push(chunk);
      return !failing;
    };
    const readLines = createLineReader((line) => {
      const action = failing ? undefined : command.readLine?.(line);
      if (action instanceof Error) fail(action);
      else if (action === "endInput") child.stdin.end();
    });
    const deadline = setTimeout(() => fail(), CATALOG_TIMEOUT_MS);
    child.on("error", () => fail());
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (collect(stdout, chunk)) readLines(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("close", (code) => {
      if (failing) return;
      clearTimeout(deadline);
      if (code === null) {
        reject(catalogFailure());
        return;
      }
      const decode = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8");
      resolve({ exitCode: code, stdout: decode(stdout), stderr: decode(stderr) });
    });
    if (command.input === undefined) child.stdin.end();
    else child.stdin.write(command.input);
  });
}

function catalogFailure(): Error {
  return new Error("The model catalog command failed.");
}

// Closes stdin and sends `SIGTERM`, then `SIGKILL` after a grace. Calls `onExit` once the process
// has exited, so that the caller cannot exit first and leave it running.
function stopChild(child: ChildProcessWithoutNullStreams, onExit: () => void): void {
  // A descendant can still hold the pipes after the child exits.
  const finish = (): void => {
    child.stdout.destroy();
    child.stderr.destroy();
    onExit();
  };
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    finish();
    return;
  }
  child.stdin.end();
  child.kill("SIGTERM");
  const escalation = setTimeout(() => child.kill("SIGKILL"), CATALOG_KILL_GRACE_MS);
  child.once("exit", () => {
    clearTimeout(escalation);
    finish();
  });
}

// Calls `onLine` for each LF-terminated line; an unterminated tail is not a line.
function createLineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let partial: Buffer[] = [];
  return (chunk) => {
    let start = 0;
    for (let end = chunk.indexOf(LF); end !== -1; end = chunk.indexOf(LF, start)) {
      onLine(Buffer.concat([...partial, chunk.subarray(start, end)]).toString("utf8"));
      partial = [];
      start = end + 1;
    }
    if (start < chunk.length) partial.push(chunk.subarray(start));
  };
}

// Pi's RPC mode keeps stdout for protocol records: extension output goes to stderr. Closing stdin
// after the response starts Pi's orderly shutdown. Pi reads stdin only after the extensions'
// startup handlers, so a dialog before the response can never be answered: unless it expires
// before the deadline, it fails at once.
function runPiModelCatalog(context: ModelDiscoveryContext): Promise<CatalogOutput> {
  return runCatalogCommand(
    {
      name: "pi",
      args: ["--mode", "rpc", "--no-session"],
      input: `${JSON.stringify({ id: PI_REQUEST_ID, type: "get_available_models" })}\n`,
      readLine: createPiCatalogLineReader(),
    },
    context,
  );
}

function createPiCatalogLineReader(): (line: string) => CatalogLineAction | undefined {
  let answered = false;
  return (line) => {
    const record = parsePiRecord(line);
    if (answered || record === undefined) return;
    if (isPiCatalogResponse(record)) {
      answered = true;
      return "endInput";
    }
    if (isBlockingPiDialog(record)) return new PiStartupDialogError();
  };
}

function isBlockingPiDialog(record: Record<string, unknown>): boolean {
  if (record.type !== "extension_ui_request" || !PI_DIALOG_METHODS.has(record.method)) return false;
  const { timeout } = record;
  return !(typeof timeout === "number" && timeout > 0 && timeout < CATALOG_TIMEOUT_MS);
}
