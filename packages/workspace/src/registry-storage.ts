import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateConfigSchema } from "./config.js";
import { WorkspaceError } from "./errors.js";

export function readRegistry<T>(path: string, schema: object, empty: T): T {
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
  let value: unknown;
  try {
    value = JSON.parse(text);
    validateConfigSchema<T>(value, schema, path);
  } catch (error) {
    throw new WorkspaceError(
      `Invalid or unsupported registry ${path}. Account for running services and resources before ` +
        "upgrading registry state; automatic migration is not supported.",
      { cause: error },
    );
  }
  return value;
}

/** Call under the registry lock. Readers see either complete revision. */
export function writeRegistry(path: string, data: unknown, schema: object): void {
  validateConfigSchema(data, schema, path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(data, undefined, 2)}\n`);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
