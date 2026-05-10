import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function patchEnvFile(content: string, patches: Record<string, string>): string {
  const lines = content.trimEnd().split("\n");
  for (const [key, value] of Object.entries(patches)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx !== -1) {
      lines[idx] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function extractHost(content: string, key: string, fallback = "localhost"): string {
  const re = new RegExp(`^${key}=(?:https?://)?([^:\\s]+)`, "m");
  const m = content.match(re);
  return m ? m[1] : fallback;
}

/**
 * Reads `<varName>=<value>` from a dotenv-style file and parses it as a port.
 * Exits with code 1 on missing file, missing variable, or non-numeric value.
 */
export function readPortFromEnvFile(file: string, varName: string): number {
  if (!existsSync(file)) {
    console.error(`Error: ${file} not found. Run setup-worktree first.`);
    process.exit(1);
  }
  const content = readFileSync(file, "utf-8");
  const match = content.match(new RegExp(`^${varName}=(.+)`, "m"));
  if (!match) {
    console.error(`Error: ${varName} not found in ${file}.`);
    process.exit(1);
  }
  return toPort(match[1].trim(), file);
}

/**
 * Reads a dotted path (e.g. `server.port`) from a JSON file and parses it as a port.
 * Exits with code 1 on missing file, missing path, or non-numeric value.
 */
export function readPortFromJsonFile(file: string, jsonPath: string): number {
  if (!existsSync(file)) {
    console.error(`Error: ${file} not found. Run setup-worktree first.`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(file, "utf-8"));
  let cur: unknown = data;
  for (const seg of jsonPath.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      console.error(`Error: ${jsonPath} not found in ${file}.`);
      process.exit(1);
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === undefined || cur === null) {
    console.error(`Error: ${jsonPath} not found in ${file}.`);
    process.exit(1);
  }
  return toPort(String(cur), file);
}

function toPort(raw: string, file: string): number {
  const port = Number(raw);
  if (!Number.isFinite(port)) {
    console.error(`Error: invalid port "${raw}" in ${file}.`);
    process.exit(1);
  }
  return port;
}

export interface CopyAndPatchCtx {
  currentWorktree: string;
  mainWorktree: string;
  log: (msg: string) => void;
}

export function copyAndPatchFile(
  ctx: CopyAndPatchCtx,
  relPath: string,
  patchFn: (content: string) => string,
  label: string,
  force: boolean,
  required = false,
): void {
  const targetPath = join(ctx.currentWorktree, relPath);
  const sourcePath = join(ctx.mainWorktree, relPath);
  const alreadyExists = existsSync(targetPath);

  if (alreadyExists && !force) {
    ctx.log(`Skipped ${label} (already exists; use --force to overwrite).`);
    return;
  }

  if (!existsSync(sourcePath)) {
    if (required) {
      console.error(`Error: ${relPath} not found in main worktree (required).`);
      process.exit(1);
    }
    ctx.log(`Warning: ${relPath} not found in main worktree, skipping.`);
    return;
  }

  const content = readFileSync(sourcePath, "utf-8");
  const patched = patchFn(content);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, patched);
  ctx.log(`${alreadyExists ? "Overwritten" : "Created"} ${label}.`);
}
