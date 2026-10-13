import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ConfigError } from "./errors.js";
import { formatRange, type PortRange } from "./ports.js";

/**
 * Compares the `ports` range of the dev-server config with `portRange` in the worktree's
 * `.alignfirst.json`. A missing file skips the check.
 */
export function checkPortClaim(currentWorktree: string, range: PortRange | undefined): void {
  const path = join(currentWorktree, ".alignfirst.json");
  if (!existsSync(path)) return;
  const claimed = readPortRange(path);
  if (range === undefined) {
    if (claimed !== undefined)
      throw new ConfigError(
        `Config error: .alignfirst.json declares \`portRange\` ${formatRange(claimed)} but ` +
          "dev-server.mjs declares no `ports`. Remove `portRange` or declare the `ports` group.",
      );
    return;
  }
  if (claimed === undefined)
    throw new ConfigError(
      "Config error: .alignfirst.json declares no `portRange`; the `ports` group of " +
        `dev-server.mjs claims ${formatRange(range)}. Write ${formatJsonRange(range)}.`,
    );
  if (claimed.first === range.first && claimed.last === range.last) return;
  throw new ConfigError(
    `Config error: \`portRange\` in .alignfirst.json is ${formatRange(claimed)}; the \`ports\` ` +
      `group of dev-server.mjs claims ${formatRange(range)}. Write ${formatJsonRange(range)} or ` +
      "fix the `ports` group.",
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

function formatJsonRange(range: PortRange): string {
  return `\`"portRange": { "first": ${range.first}, "last": ${range.last} }\``;
}
