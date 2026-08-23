import { existsSync } from "node:fs";
import type { AgentToolCall, ScenarioContext } from "@paleo/openclaw-test";
import { execCommandOf } from "./agent-tool-calls.ts";
import type { AlprojectMockCall } from "./mock-alproject.ts";

export interface WaitForLifecycleOptions {
  timeoutMs?: number;
  label: string;
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

export function assertAlprojectCallOrder(
  calls: AlprojectMockCall[],
  first: (call: AlprojectMockCall) => boolean,
  second: (call: AlprojectMockCall) => boolean,
  label: string,
): void {
  const firstIndex = calls.findIndex(first);
  const secondIndex = calls.findIndex(second);
  if (firstIndex === -1 || secondIndex === -1 || firstIndex >= secondIndex) {
    throw new Error(`${label}: ${JSON.stringify(calls)}`);
  }
}

export function assertAgentCommandOrder(
  calls: AgentToolCall[],
  first: (command: string) => boolean,
  second: (command: string) => boolean,
  label: string,
): void {
  const commands = calls.map(execCommandOf).filter((command) => command !== undefined);
  const firstIndex = commands.findIndex(first);
  const secondIndex = commands.findIndex(second);
  if (firstIndex === -1 || secondIndex === -1 || firstIndex >= secondIndex) {
    throw new Error(`${label}: ${JSON.stringify(commands)}`);
  }
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}
