import { entryName, GLOBAL_REALM, type Memory } from "../memory/memory.js";
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

// Whose model list it is: the agent's environment, and the selected profile, absent for the
// built-in defaults.
export interface ModelListOwner {
  env: NodeJS.ProcessEnv;
  profile?: string;
}

export async function readModelList(
  memory: Memory,
  harness: CodingAgent,
  owner: ModelListOwner,
): Promise<StoredModelList | undefined> {
  const row = await memory.read(GLOBAL_REALM, modelListEntry(harness, owner));
  if (row === undefined || !isModelListRecord(row.payload)) return;
  const { cliVersion, configDir, models } = row.payload;
  return { cliVersion, configDir, models, updatedAt: row.updatedAt };
}

export function writeModelList(
  memory: Memory,
  harness: CodingAgent,
  owner: ModelListOwner,
  record: ModelListRecord,
): Promise<void> {
  const { cliVersion, configDir, models } = record;
  return memory.write(GLOBAL_REALM, modelListEntry(harness, owner), {
    cliVersion,
    configDir,
    models,
  });
}

// `harness:{harness}:profile:{profile}:models`, without the profile pair for the built-in defaults.
function modelListEntry(harness: CodingAgent, owner: ModelListOwner): string {
  const profile: [string, string][] =
    owner.profile === undefined ? [] : [["profile", owner.profile]];
  return entryName([["harness", harness], ...profile], "models");
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

// The value of the harness's native directory variable in the agent's environment.
export function nativeDirectory(harness: CodingAgent, env: NodeJS.ProcessEnv): string | null {
  const variable = CONFIG_DIRECTORY_VARIABLES[harness];
  const value = variable === undefined ? undefined : env[variable];
  return value === undefined || value === "" ? null : value;
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
