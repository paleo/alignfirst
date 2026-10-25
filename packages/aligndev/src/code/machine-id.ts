import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { errorMessage } from "../errors.js";

export function readMachineId(home: string): string {
  const path = join(home, ".alignfirst", "machine-id");
  try {
    const id = readOrCreateMachineId(path).trim();
    if (id === "") throw new Error("file is empty");
    return id;
  } catch (error) {
    throw new Error(`Could not read machine identity at ${path}: ${errorMessage(error)}`);
  }
}

function readOrCreateMachineId(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, randomUUID());
    publishMachineId(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return readFileSync(path, "utf8");
}

// The link publishes the complete file; the first creator wins.
function publishMachineId(tmp: string, path: string): void {
  try {
    linkSync(tmp, path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
}
