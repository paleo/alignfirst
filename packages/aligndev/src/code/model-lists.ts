import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { entryName, GLOBAL_REALM, type Memory, type MemoryRow } from "../memory/memory.js";
import type { CodingAgent } from "./coding-agent.js";
import { CONFIG_DIRECTORY_VARIABLES } from "./harness-environment.js";

// The model list of a harness and profile, as its catalog command listed it.
export interface ModelListRecord {
  // The first line that `<cli> --version` printed; empty when the command failed.
  cliVersion: string;
  // The native directory variable of the agent's environment; null when unset.
  configDir: string | null;
  // The native ids.
  models: readonly string[];
}

export interface StoredModelList extends ModelListRecord {
  updatedAt: Date;
}

// Whose model list it is: the agent's working directory and environment, and the selected profile,
// absent for the built-in defaults.
export interface ModelListOwner {
  cwd: string;
  env: NodeJS.ProcessEnv;
  profile?: string;
}

export async function readModelList(
  memory: Memory,
  harness: CodingAgent,
  owner: ModelListOwner,
): Promise<StoredModelList | undefined> {
  return toStoredModelList(await memory.read(GLOBAL_REALM, modelListEntry(harness, owner)));
}

// The list as written; undefined when the memory is unavailable.
export async function writeModelList(
  memory: Memory,
  harness: CodingAgent,
  owner: ModelListOwner,
  record: ModelListRecord,
): Promise<StoredModelList | undefined> {
  const { cliVersion, configDir, models } = record;
  const row = await memory.write(GLOBAL_REALM, modelListEntry(harness, owner), {
    cliVersion,
    configDir,
    models,
  });
  return toStoredModelList(row);
}

// `harness:{harness}:profile:{profile}:cwd:{directory}:models`. The built-in defaults have no
// profile pair, and only a Pi project directory has a cwd pair.
function modelListEntry(harness: CodingAgent, owner: ModelListOwner): string {
  const profile: [string, string][] =
    owner.profile === undefined ? [] : [["profile", owner.profile]];
  const directory = harness === "pi" ? piProjectDirectory(owner.cwd) : undefined;
  const cwd: [string, string][] = directory === undefined ? [] : [["cwd", directory]];
  return entryName([["harness", harness], ...profile, ...cwd], "models");
}

// Pi loads the project extensions, which can add models, from `<cwd>/.pi` only. The real path of a
// working directory that holds it; undefined otherwise.
function piProjectDirectory(cwd: string): string | undefined {
  try {
    if (statSync(join(cwd, ".pi"), { throwIfNoEntry: false })?.isDirectory() !== true) return;
    return realpathSync(cwd);
  } catch {
    return;
  }
}

function toStoredModelList(row: MemoryRow | undefined): StoredModelList | undefined {
  if (row === undefined || !isModelListRecord(row.payload)) return;
  const { cliVersion, configDir, models } = row.payload;
  return { cliVersion, configDir, models, updatedAt: row.updatedAt };
}

function isModelListRecord(payload: unknown): payload is ModelListRecord {
  if (typeof payload !== "object" || payload === null) return false;
  if (!("cliVersion" in payload && "configDir" in payload && "models" in payload)) return false;
  const { cliVersion, configDir, models } = payload;
  return (
    typeof cliVersion === "string" &&
    (configDir === null || typeof configDir === "string") &&
    Array.isArray(models) &&
    models.every((model) => typeof model === "string")
  );
}

// The harness's native directory variable of the agent's environment. A relative value names a
// directory under the working directory. Pi expands a leading `~`, so such a value is kept.
export function nativeDirectory(harness: CodingAgent, { cwd, env }: ModelListOwner): string | null {
  const variable = CONFIG_DIRECTORY_VARIABLES[harness];
  const value = variable === undefined ? undefined : env[variable];
  if (value === undefined || value === "") return null;
  return isAbsolute(value) || value.startsWith("~") ? value : resolve(cwd, value);
}

// Same CLI version, same native directory, and written on the local calendar day of `now`.
export function isFresh(
  list: StoredModelList,
  cliVersion: string,
  configDir: string | null,
  now: Date,
): boolean {
  return (
    list.cliVersion === cliVersion &&
    list.configDir === configDir &&
    sameLocalDay(list.updatedAt, now)
  );
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
