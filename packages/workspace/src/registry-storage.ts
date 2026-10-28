import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateConfigSchema } from "./config.js";
import { WorkspaceError } from "./errors.js";
import { assertRegistryPath, assertSelectedRegistry, registryOwner } from "./registry-ownership.js";

export function readRegistry<T>(path: string, schema: object, empty: T, mainWorktree: string): T {
  assertRegistryPath(mainWorktree, dirname(path), path);
  assertSelectedRegistry(mainWorktree, dirname(path));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      lstatSync(path, { throwIfNoEntry: false }) === undefined
    )
      return empty;
    throw new WorkspaceError(`Cannot read registry ${path}. Check permissions.`, { cause: error });
  }
  try {
    const value: unknown = JSON.parse(text);
    validateConfigSchema<T>(value, schema, path);
    return value;
  } catch (error) {
    throw new WorkspaceError(
      `Invalid or unsupported registry ${path}. Account for running services and resources before ` +
        "upgrading registry state; automatic migration is not supported.",
      { cause: error },
    );
  }
}

/** Call under the shared lock before any resource-producing effects or sidecar writes. */
export function claimRegistryStorage(mainWorktree: string, registryDir: string): void {
  assertSelectedRegistry(mainWorktree, registryDir);
  const path = join(registryDir, "workspaces.json");
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) return;
  writeRegistry(
    path,
    {
      version: 4,
      storage: registryOwner(mainWorktree, registryDir),
      workspaces: {},
      runtimeOwners: {},
    },
    { type: "object" },
    mainWorktree,
  );
}

/** Call under the registry lock. Readers see either complete revision. */
export function writeRegistry(
  path: string,
  data: unknown,
  schema: object,
  mainWorktree: string,
): void {
  assertRegistryPath(mainWorktree, dirname(path), path);
  assertSelectedRegistry(mainWorktree, dirname(path));
  validateConfigSchema(data, schema, path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(data, undefined, 2)}\n`);
    assertRegistryPath(mainWorktree, dirname(path), path);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
