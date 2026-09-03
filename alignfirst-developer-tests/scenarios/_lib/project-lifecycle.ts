import { existsSync, readFileSync } from "node:fs";
import type { AgentToolCall, ScenarioContext } from "@paleo/openclaw-test";
import { execCommandOf, listsProjects } from "./agent-tool-calls.ts";
import { PROJECT_CONFIG_FILENAME } from "./project-fixtures.ts";

export interface WaitForLifecycleOptions {
  timeoutMs?: number;
  label: string;
}

export interface ProjectConfig {
  portRange?: PortRange;
}

interface PortRange {
  first: number;
  last: number;
}

export async function waitForLifecycle(
  predicate: () => boolean,
  { timeoutMs = 180_000, label }: WaitForLifecycleOptions,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not complete within ${timeoutMs}ms`);
}

export async function assertGatewayCommand(
  ctx: ScenarioContext,
  argv: string[],
  label: string,
): Promise<string> {
  const result = await ctx.execInGateway(argv, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function waitForProjectListing(ctx: ScenarioContext, label: string): Promise<void> {
  await ctx.waitForAgentToolCall(listsProjects, { label });
}

export function readProjectConfig(path: string): ProjectConfig | undefined {
  const configPath = `${path}/${PROJECT_CONFIG_FILENAME}`;
  if (!existsSync(configPath)) return;
  const value: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!isRecord(value)) throw new Error(`invalid project config: ${configPath}`);
  const portRange = parsePortRange(value.portRange, configPath);
  return portRange === undefined ? {} : { portRange };
}

function parsePortRange(value: unknown, configPath: string): PortRange | undefined {
  if (value === undefined) return;
  if (!isRecord(value) || typeof value.first !== "number" || typeof value.last !== "number") {
    throw new Error(`invalid port range in project config: ${configPath}`);
  }
  return { first: value.first, last: value.last };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Assert `first` matches before `second` across the exec commands, in call
 * order. Positions are taken in the joined command text: an agent may batch
 * both steps into one compound command (`git init && … && git commit`), which
 * is correct as long as the order holds within it.
 */
export function assertAgentCommandOrder(
  calls: AgentToolCall[],
  first: RegExp,
  second: RegExp,
  label: string,
): void {
  const text = calls
    .map(execCommandOf)
    .filter((command): command is string => command !== undefined)
    .join("\n");
  const firstIndex = text.search(first);
  const secondIndex = text.search(second);
  if (firstIndex === -1 || secondIndex === -1 || firstIndex >= secondIndex) {
    throw new Error(`${label}: ${JSON.stringify(text.slice(0, 2000))}`);
  }
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}
