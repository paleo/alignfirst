import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import type { CodingAgent } from "./coding-agent.js";
import { resolveEfforts } from "./efforts.js";

export const CLAUDE_DEFAULT_MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export const CODEX_DEFAULT_MODELS = ["astra", "sol", "terra", "luna"] as const;
// The version placeholder of a model pattern.
export const LATEST = "{latest}";
export const NO_DECLARED_MODEL =
  "the profile declares no Pi model; declare modelFamilies, modelAliases or models";

const AGY_MODEL_ALIASES = ["carbon", "neon", "hydrogen", "flash"] as const;
// Each family lists its aliases from the biggest model to the smallest.
const MODEL_FAMILIES: Readonly<Record<string, ModelFamily>> = {
  gpt: { aliases: CODEX_DEFAULT_MODELS, toPattern: (alias) => `gpt-${LATEST}-${alias}` },
  claude: { aliases: CLAUDE_DEFAULT_MODELS, toPattern: (alias) => `claude-${alias}-${LATEST}` },
  gemini: { aliases: AGY_MODEL_ALIASES, toPattern: (alias) => `gemini-${LATEST}-${alias}` },
};
export const MODEL_FAMILY_NAMES: readonly string[] = Object.keys(MODEL_FAMILIES);

const MODEL_PATTERN_HELP: Readonly<Record<CatalogAgent, ModelPatternHelp>> = {
  codex: {
    label: "Codex",
    remedy: "update the Codex CLI, or pin a full slug in the profile's `modelAliases`.",
  },
  pi: {
    label: "Pi",
    remedy:
      "check the pattern against `pi --list-models` (a Pi pattern is `provider/model`), update " +
      "Pi or its model catalogs (`pi update`), check the provider credentials, or pin a full " +
      "`provider/model` selector in the profile's `modelAliases`.",
  },
  agy: {
    label: "Antigravity",
    remedy:
      "check the pattern against `agy models`, update Antigravity, check its sign-in, or pin a " +
      "full model name in the profile's `modelAliases`.",
  },
};
const VERSION_EXPRESSION = "(\\d{1,3})(?:[.-](\\d{1,3}))?";
const CATALOG_MAX_BUFFER = 8 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 30_000;
const CATALOG_KILL_GRACE_MS = 5_000;
const PI_REQUEST_ID = "aligndev-models";
const PI_DIALOG_METHODS: ReadonlySet<unknown> = new Set(["select", "confirm", "input", "editor"]);
const LF = 0x0a;

export type CatalogAgent = "codex" | "pi" | "agy";

interface ModelFamily {
  aliases: readonly string[];
  toPattern(alias: string): string;
}

interface ModelPatternHelp {
  label: string;
  remedy: string;
}

// What the model functions read from a profile.
export interface ModelSettings {
  harness: CodingAgent;
  models?: readonly string[];
  modelAliases?: Readonly<Record<string, string>>;
  modelFamilies?: Readonly<Record<string, string>>;
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

interface CatalogEntry {
  run: ModelCatalogRunner;
  isSignInRequired(output: CatalogOutput): boolean;
  parse(stdout: string): readonly CatalogModel[];
}

// A text that a pattern matches, and the selector that launches its model.
interface CatalogModel {
  text: string;
  selector: string;
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

// The accepted model names of a profile: `undefined` means any nonblank name, an empty list none.
export function resolveModels(profile: ModelSettings): readonly string[] | undefined {
  if (profile.models !== undefined && profile.models.length > 0) return profile.models;
  if (profile.harness === "agy") return;
  return [
    ...new Set([...builtInAliases(profile).keys(), ...Object.keys(profile.modelAliases ?? {})]),
  ];
}

export function expandBuiltInAlias(
  profile: ModelSettings,
  model: string | undefined,
): string | undefined {
  if (model === undefined) return;
  return builtInAliases(profile).get(model) ?? model;
}

// Maps each built-in alias of the profile to its selector, biggest model first.
function builtInAliases(profile: ModelSettings): ReadonlyMap<string, string> {
  switch (profile.harness) {
    case "claude":
      return new Map(CLAUDE_DEFAULT_MODELS.map((alias) => [alias, alias]));
    case "codex":
      return new Map(familyAliases("gpt"));
    case "agy":
      return new Map(familyAliases("gemini"));
    case "pi":
      return new Map(
        Object.entries(profile.modelFamilies ?? {}).flatMap(([family, prefix]) =>
          familyAliases(family, `${prefix}/`),
        ),
      );
  }
}

function familyAliases(family: string, prefix = ""): [string, string][] {
  if (!Object.hasOwn(MODEL_FAMILIES, family)) return [];
  const { aliases, toPattern } = MODEL_FAMILIES[family];
  return aliases.map((alias) => [alias, `${prefix}${toPattern(alias)}`]);
}

export function createExecutableModelResolver(
  runners: Partial<Record<CatalogAgent, ModelCatalogRunner>> = {},
): ExecutableModelResolver {
  const entries = createCatalogEntries(runners);
  const catalogs: CatalogCache = new WeakMap();
  return async (agent, selectedModel, context) => {
    if (selectedModel === undefined) return;
    if (!isCatalogAgent(agent) || !selectedModel.includes(LATEST)) return selectedModel;
    try {
      const models = await loadCatalog(catalogs, agent, entries[agent], context);
      return selectNewestModel(models, selectedModel);
    } catch (error) {
      if (error instanceof ModelSignInRequiredError || error instanceof PiStartupDialogError) {
        throw error;
      }
      throw new Error(modelPatternError(agent, selectedModel));
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
      run:
        runners.codex ??
        ((context) =>
          runCatalogCommand({ name: "codex", args: ["debug", "models", "--bundled"] }, context)),
      isSignInRequired: () => false,
      parse: (stdout) => parseBundledModelSlugs(stdout).map(toCatalogModel),
    },
    pi: {
      run: runners.pi ?? runPiModelCatalog,
      isSignInRequired: isPiCatalogSignInRequired,
      parse: (stdout) => parsePiModels(stdout).map(toCatalogModel),
    },
    agy: {
      run:
        runners.agy ?? ((context) => runCatalogCommand({ name: "agy", args: ["models"] }, context)),
      isSignInRequired: isAgyCatalogSignInRequired,
      parse: parseAgyModelList,
    },
  };
}

function toCatalogModel(selector: string): CatalogModel {
  return { text: selector, selector };
}

function isCatalogAgent(agent: CodingAgent): agent is CatalogAgent {
  return Object.hasOwn(MODEL_PATTERN_HELP, agent);
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
    throw new ModelSignInRequiredError(`${MODEL_PATTERN_HELP[agent].label} requires sign-in.`);
  }
  if (output.exitCode !== 0) throw new Error("The model catalog command failed.");
  return entry.parse(output.stdout);
}

// The selector whose text is the pattern with the newest version in place of `{latest}`.
function selectNewestModel(models: readonly CatalogModel[], pattern: string): string {
  const expression = toVersionExpression(pattern);
  const candidates = models.flatMap(({ text, selector }): VersionedSelector[] => {
    const match = expression.exec(text);
    return match ? [{ selector, major: Number(match[1]), minor: Number(match[2] ?? 0) }] : [];
  });
  if (candidates.length === 0) throw new Error("The model catalog contains no matching model.");
  const newest = candidates.reduce((best, candidate) =>
    compareVersions(candidate, best) > 0 ? candidate : best,
  );
  const [selector, ...others] = new Set(
    candidates.filter((c) => compareVersions(c, newest) === 0).map((c) => c.selector),
  );
  if (others.length > 0) throw new Error("Several models share the newest version.");
  return selector;
}

interface VersionedSelector {
  selector: string;
  major: number;
  minor: number;
}

function compareVersions(a: VersionedSelector, b: VersionedSelector): number {
  return a.major === b.major ? a.minor - b.minor : a.major - b.major;
}

// A second `{latest}` stays literal text, which no catalog holds.
function toVersionExpression(pattern: string): RegExp {
  const at = pattern.indexOf(LATEST);
  const before = pattern.slice(0, at);
  const after = pattern.slice(at + LATEST.length);
  return new RegExp(`^${escapeRegExp(before)}${VERSION_EXPRESSION}${escapeRegExp(after)}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function modelPatternError(agent: CatalogAgent, pattern: string): string {
  const { label, remedy } = MODEL_PATTERN_HELP[agent];
  return (
    `Unable to resolve ${label} model pattern ${JSON.stringify(pattern)} from its model catalog. ` +
    `To fix it, ${remedy}`
  );
}

// The remedy for a selector that the catalog of its harness resolves.
export function modelPatternHint(
  agent: CodingAgent,
  selector: string | undefined,
): string | undefined {
  if (selector === undefined || !isCatalogAgent(agent) || !selector.includes(LATEST)) return;
  const { label, remedy } = MODEL_PATTERN_HELP[agent];
  return `For the ${label} model pattern ${JSON.stringify(selector)}, ${remedy}`;
}

export function expandModelAlias(
  model: string | undefined,
  aliases: Readonly<Record<string, string>> = {},
): string | undefined {
  return model !== undefined && Object.hasOwn(aliases, model) ? aliases[model] : model;
}

function parseBundledModelSlugs(output: string): readonly string[] {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Pi answers with an empty list when no provider has credentials.
function isPiCatalogSignInRequired(output: CatalogOutput): boolean {
  return output.exitCode === 0 && readPiModels(output.stdout)?.length === 0;
}

function parsePiModels(stdout: string): readonly string[] {
  const models = readPiModels(stdout);
  if (models === undefined) throw new Error("Pi returned no model list");
  return models;
}

// The `<provider>/<id>` selectors of the RPC response to `get_available_models`, among the other
// protocol records of stdout.
function readPiModels(stdout: string): string[] | undefined {
  const response = findPiResponse(stdout);
  if (response?.success !== true || !isRecord(response.data)) return;
  const { models } = response.data;
  if (!Array.isArray(models)) return;
  const result: string[] = [];
  for (const model of models) {
    if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") {
      return;
    }
    result.push(`${model.provider}/${model.id}`);
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

// Antigravity lists one id per effort of a model. A pattern matches the id or its name without the
// effort, and both launch that name.
function parseAgyModelList(output: string): readonly CatalogModel[] {
  const efforts = resolveEfforts("agy", undefined);
  return nonblankLines(output).flatMap((line) => {
    const tab = line.indexOf("\t");
    const id = tab === -1 ? undefined : line.slice(0, tab).trim();
    if (id === undefined || id.length === 0) {
      throw new Error("Antigravity returned a malformed model line");
    }
    const effort = efforts.find((level) => id.endsWith(`-${level}`));
    if (effort === undefined) return [toCatalogModel(id)];
    const selector = id.slice(0, -effort.length - 1);
    return [{ text: id, selector }, toCatalogModel(selector)];
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
