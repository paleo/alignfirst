import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ConfigError } from "./errors.js";
import type { ResolvedPortsConfig } from "./ports.js";

interface PortRange {
  first: number;
  last: number;
}

export function checkPortClaim(
  currentWorktree: string,
  ports: ResolvedPortsConfig | undefined,
): void {
  const path = join(currentWorktree, ".alignfirst.json");
  if (!existsSync(path)) return;
  const range = readPortRange(path);
  if (ports === undefined) {
    if (range !== undefined)
      throw new ConfigError(
        `Config error: .alignfirst.json declares \`portRange\` ${formatRange(range)} but ` +
          "workspace.mjs declares no `ports`. Remove `portRange` or declare the port scheme.",
      );
    return;
  }
  const expected = expectedPortRange(ports);
  if (range === undefined)
    throw new ConfigError(
      "Config error: .alignfirst.json declares no `portRange`; the port scheme of workspace.mjs " +
        `claims ${formatRange(expected)}. Write ${formatJsonRange(expected)}.`,
    );
  if (range.first === expected.first && range.last === expected.last) return;
  throw new ConfigError(
    `Config error: \`portRange\` in .alignfirst.json is ${formatRange(range)}; the port scheme of ` +
      `workspace.mjs claims ${formatRange(expected)}. Write ${formatJsonRange(expected)} or fix the scheme.`,
  );
}

function readPortRange(path: string): PortRange | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new ConfigError(`Config error: ${path} is not valid JSON.`);
  }
  if (!isRecord(value) || !isPortRange(value.portRange)) return;
  return value.portRange;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPortRange(value: unknown): value is PortRange {
  return isRecord(value) && Number.isInteger(value.first) && Number.isInteger(value.last);
}

function expectedPortRange(ports: ResolvedPortsConfig): PortRange {
  return {
    first: ports.base,
    last: ports.base + ports.perWorkspace * ports.maxWorkspaces - 1,
  };
}

function formatRange(range: PortRange): string {
  return `${range.first}..${range.last}`;
}

function formatJsonRange(range: PortRange): string {
  return `\`"portRange": { "first": ${range.first}, "last": ${range.last} }\``;
}
