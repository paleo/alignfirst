import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { WorkspaceError } from "./errors.js";
import { wsCmd } from "./package-manager.js";

export function setupLogPath(worktreeRoot: string, runtimeDir: string): string {
  return join(worktreeRoot, runtimeDir, "logs", "workspace-setup.log");
}

export function setupProgressPath(worktreeRoot: string, runtimeDir: string): string {
  return join(worktreeRoot, runtimeDir, "logs", "workspace-setup.progress");
}

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
 * The project name Docker Compose derives from a directory name: lowercased, every character
 * outside `[a-z0-9_-]` dropped, leading `-` and `_` trimmed. Compose prefixes its containers
 * (`<project>-<service>-1`) and volumes (`<project>_<volume>`) with it.
 */
export function composeProjectName(workspaceName: string): string {
  return workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+/, "");
}

export function lastLines(content: string, count: number): string {
  if (count <= 0) return "";
  return content.split("\n").slice(-count).join("\n");
}

/**
 * Reads `<varName>=<value>` from a dotenv-style file and parses it as a port.
 * Exits with code 1 on missing file, missing variable, or non-numeric value.
 */
export function readPortFromEnvFile(file: string, varName: string): number {
  if (!existsSync(file)) {
    console.error(`Error: ${file} not found. Run \`${wsCmd("setup")}\` first.`);
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
    console.error(`Error: ${file} not found. Run \`${wsCmd("setup")}\` first.`);
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

/** Resolved initial-content source for {@link copyAndPatchFile}. `path` is absolute. */
export type ResolvedFileSource = { path: string } | { content: string };

export interface CopyAndPatchOptions {
  currentWorktree: string;
  /** Target path, relative to `currentWorktree`. Also the label of the outcome. */
  relPath: string;
  /** Called only when the target is (re)seeded from its source. */
  resolveSource: () => Promise<ResolvedFileSource>;
  patch?: (content: string) => string;
  force: boolean;
  optional: boolean;
}

export type CopyAndPatchOutcome =
  | { kind: "created" | "overwritten" | "updated" | "upToDate" | "keptExisting" }
  | { kind: "sourceMissing"; sourcePath: string };

export async function copyAndPatchFile(options: CopyAndPatchOptions): Promise<CopyAndPatchOutcome> {
  const { relPath, patch } = options;
  const targetPath = join(options.currentWorktree, relPath);
  const alreadyExists = existsSync(targetPath);

  if (alreadyExists && !options.force) {
    if (patch === undefined) return { kind: "keptExisting" };
    return reconcileExistingFile(targetPath, relPath, patch);
  }

  const source = await options.resolveSource();
  let content: string;
  if ("content" in source) {
    content = source.content;
  } else {
    if (!existsSync(source.path)) {
      if (!options.optional) {
        throw new WorkspaceError(
          `config source ${source.path} not found. Bootstrap it first ` +
            `(\`${wsCmd("setup")}\`, or commit the template), or mark the entry as optional.`,
        );
      }
      return { kind: "sourceMissing", sourcePath: source.path };
    }
    content = readFileSync(source.path, "utf-8");
  }

  const patched = patch === undefined ? content : patch(content);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, patched);
  return { kind: alreadyExists ? "overwritten" : "created" };
}

/**
 * Re-applies `patch` to the file as it is: a patch rewrites only the keys it knows, so local
 * customizations survive. The source is never resolved, and the file is rewritten only when the
 * result differs. Throws, before any write, when the patch is not idempotent.
 */
function reconcileExistingFile(
  targetPath: string,
  relPath: string,
  patch: (content: string) => string,
): CopyAndPatchOutcome {
  const content = readFileSync(targetPath, "utf-8");
  const patched = patch(content);
  if (patched === content) return { kind: "upToDate" };
  if (patch(patched) !== patched) {
    throw new WorkspaceError(
      `patch of ${relPath} is not idempotent: applying it twice gives a different result. ` +
        "A patch must rewrite only the keys it owns.",
    );
  }
  writeFileSync(targetPath, patched);
  return { kind: "updated" };
}

/**
 * Formats a millisecond duration as the two largest units among `d`/`h`/`m`/`s`.
 * Drops the smaller unit when zero (`5d` instead of `5d 0h`). Sub-second values
 * round up to `1s` (zero stays `0s`). Negative input returns `0s`.
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms < 1000) return "1s";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const units: [string, number][] = [
    ["d", d],
    ["h", h],
    ["m", m],
    ["s", s],
  ];
  const topIdx = units.findIndex(([, v]) => v > 0);
  if (topIdx === -1) return "0s";
  const [topLabel, topVal] = units[topIdx];
  const next = units[topIdx + 1];
  if (!next || next[1] === 0) return `${topVal}${topLabel}`;
  return `${topVal}${topLabel} ${next[1]}${next[0]}`;
}

/**
 * Detects common fatal JS startup failures in a log buffer. Returns a short marker string
 * naming the matched pattern, or `false` when none match. Used as the default `detectError`
 * for spawn servers that don't supply one. A custom `detectError` can compose with this:
 * `detectError: (log) => myDetector(log) || helpers.detectCommonJsError(log)`.
 */
export function detectCommonJsError(log: string): string | false {
  if (log.includes("[nodemon] app crashed")) return "[nodemon] app crashed";
  if (/^Node\.js v/m.test(log)) return "Node.js v";
  if (log.includes("Error: Cannot find module ")) return "Error: Cannot find module";
  if (/^SyntaxError: /m.test(log)) return "SyntaxError";
  if (log.includes("UnhandledPromiseRejection")) return "UnhandledPromiseRejection";
  return false;
}

function toPort(raw: string, file: string): number {
  const port = Number(raw);
  if (!Number.isFinite(port)) {
    console.error(`Error: invalid port "${raw}" in ${file}.`);
    process.exit(1);
  }
  return port;
}
