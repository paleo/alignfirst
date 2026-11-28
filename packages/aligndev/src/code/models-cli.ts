import {
  type CodeConfig,
  enabledCodingProfiles,
  type LoadedConfig,
  resolveCodeConfig,
} from "../config.js";
import type { Output } from "../output.js";
import { describeModelFailure } from "./model-failure.js";
import type { StoredModelList } from "./model-lists.js";
import {
  type CatalogAgent,
  expandBuiltInAlias,
  expandModelAlias,
  isCatalogAgent,
  LATEST,
  type ModelDiscoveryContext,
  type ModelLists,
  resolveModels,
} from "./models.js";
import { describeProfile, modelDiscoveryContext } from "./native-context.js";

const NO_SINGLE_MATCH = "no single match in the list";

export interface ModelsContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Output;
  stderr: Output;
  modelLists: ModelLists;
}

export interface ModelsOptions {
  profile?: string;
  refresh: boolean;
}

// The accepted names of a profile, with their selectors.
interface ProfileModels {
  code: CodeConfig;
  context: ModelDiscoveryContext;
  names: AcceptedName[];
  // The harness whose catalog resolves the patterns; undefined without any pattern.
  catalogAgent?: CatalogAgent;
}

interface AcceptedName {
  name: string;
  selector: string;
  isPattern: boolean;
}

// The lists shown for a profile: `previous` only when a refresh replaced it.
interface ShownLists {
  current?: StoredModelList;
  previous?: StoredModelList;
}

// Reports the accepted names of each covered profile and the model each one selects in the
// remembered list. Only `--refresh` runs native commands.
export async function showModels(
  ctx: ModelsContext,
  config: LoadedConfig,
  options: ModelsOptions,
): Promise<number> {
  const profiles = coveredProfiles(config, ctx.env, options.profile).map((code) =>
    describeProfileModels(code, ctx.cwd),
  );
  const unavailability = await ctx.modelLists.unavailability();
  if (unavailability !== undefined) {
    const reports = profiles.map((profile) => renderProfile(ctx.modelLists, profile, {}));
    ctx.stdout.write(
      `The AlignDev memory is unavailable: ${unavailability}\n\n${reports.join("\n")}`,
    );
    return options.refresh ? 1 : 0;
  }
  let exitCode = 0;
  const reports: string[] = [];
  for (const profile of profiles) {
    const { lists, failed } = await loadLists(ctx, profile, options.refresh);
    if (failed) exitCode = 1;
    reports.push(renderProfile(ctx.modelLists, profile, lists));
  }
  ctx.stdout.write(reports.join("\n"));
  return exitCode;
}

// Every enabled coding-agent profile, else the effective built-in profile.
function coveredProfiles(
  config: LoadedConfig,
  env: NodeJS.ProcessEnv,
  profile: string | undefined,
): CodeConfig[] {
  if (profile !== undefined) return [resolveCodeConfig(config, env, { explicit: profile })];
  const named = enabledCodingProfiles(config);
  if (named.length === 0) return [resolveCodeConfig(config, env)];
  return named.map(({ name }) => resolveCodeConfig(config, env, { explicit: name }));
}

function describeProfileModels(code: CodeConfig, cwd: string): ProfileModels {
  const names = resolveModels(code).map((name): AcceptedName => {
    const selector = expandBuiltInAlias(code, expandModelAlias(name, code.modelAliases)) ?? name;
    return { name, selector, isPattern: isCatalogAgent(code.harness) && selector.includes(LATEST) };
  });
  const hasPattern = names.some(({ isPattern }) => isPattern);
  return {
    code,
    context: modelDiscoveryContext(code, cwd),
    names,
    ...(hasPattern && isCatalogAgent(code.harness) ? { catalogAgent: code.harness } : {}),
  };
}

// The stored list, refreshed on request. A failed refresh keeps the stored list and writes its
// diagnostic to stderr.
async function loadLists(
  ctx: ModelsContext,
  profile: ProfileModels,
  refresh: boolean,
): Promise<{ lists: ShownLists; failed: boolean }> {
  const { catalogAgent, context } = profile;
  if (catalogAgent === undefined) return { lists: {}, failed: false };
  const stored = await ctx.modelLists.read(catalogAgent, context);
  if (!refresh) return { lists: { current: stored }, failed: false };
  try {
    const current = await ctx.modelLists.refresh(catalogAgent, context);
    return { lists: { current, previous: stored }, failed: false };
  } catch (error) {
    ctx.stderr.write(`aligndev code models: ${await refreshFailure(ctx, profile, error)}\n`);
    return { lists: { current: stored }, failed: true };
  }
}

// The text a launch with the profile's first pattern would print.
async function refreshFailure(
  ctx: ModelsContext,
  profile: ProfileModels,
  error: unknown,
): Promise<string> {
  const unavailability = await ctx.modelLists.unavailability();
  if (unavailability !== undefined) return `The AlignDev memory is unavailable: ${unavailability}`;
  const pattern = profile.names.find(({ isPattern }) => isPattern)?.selector;
  return describeModelFailure(profile.code, ctx.cwd, pattern, error).message;
}

function renderProfile(lists: ModelLists, profile: ProfileModels, shown: ShownLists): string {
  const { code, names, catalogAgent } = profile;
  const lines = [describeProfile(code)];
  if (catalogAgent !== undefined) lines.push(describeList(shown.current));
  if (names.length === 0) lines.push("  No model is declared.");
  for (const accepted of names) {
    lines.push(`  ${accepted.name}: ${describeModel(lists, catalogAgent, accepted, shown)}`);
  }
  return `${lines.join("\n")}\n`;
}

function describeList(list: StoredModelList | undefined): string {
  if (list === undefined) return "No model list remembered yet.";
  const version = list.cliVersion === "" ? "unknown" : list.cliVersion;
  return `Model list of ${localDate(list.updatedAt)}, CLI version ${version}`;
}

function describeModel(
  lists: ModelLists,
  catalogAgent: CatalogAgent | undefined,
  { selector, isPattern }: AcceptedName,
  { current, previous }: ShownLists,
): string {
  if (!isPattern || catalogAgent === undefined) return selector;
  if (current === undefined) return `not looked up yet (${selector})`;
  const model = lists.select(catalogAgent, current, selector) ?? NO_SINGLE_MATCH;
  const before =
    previous === undefined
      ? model
      : (lists.select(catalogAgent, previous, selector) ?? NO_SINGLE_MATCH);
  return before === model ? `${model} (${selector})` : `${before} → ${model} (${selector})`;
}

function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
