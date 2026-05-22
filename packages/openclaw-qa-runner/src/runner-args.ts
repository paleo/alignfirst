import type { ChannelId } from "./report.js";

export type ChannelArg = ChannelId | "all";

export interface RunnerArgs {
  channel: ChannelArg;
  scenarios: string[];
  all: boolean;
  iterations: number;
  maxFailures: number;
}

export function parseArgs(argv: string[]): RunnerArgs {
  let channel: ChannelArg | undefined;
  let all = false;
  const scenarios: string[] = [];
  let iterations = 1;
  let maxFailures: number | undefined;
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i] as string;
    if (a === "--channel") {
      channel = parseChannel(argv[++i]);
    } else if (a.startsWith("--channel=")) {
      channel = parseChannel(a.slice("--channel=".length));
    } else if (a === "--iterations") {
      iterations = parseNonNegativeInt(argv[++i], "--iterations", 1);
    } else if (a.startsWith("--iterations=")) {
      iterations = parseNonNegativeInt(a.slice("--iterations=".length), "--iterations", 1);
    } else if (a === "--max-failures") {
      maxFailures = parseNonNegativeInt(argv[++i], "--max-failures", 0);
    } else if (a.startsWith("--max-failures=")) {
      maxFailures = parseNonNegativeInt(a.slice("--max-failures=".length), "--max-failures", 0);
    } else if (a === "--all") {
      all = true;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      scenarios.push(a);
    }
  }
  if (channel === undefined) {
    throw new Error("runner: --channel discord-mock|slack-mock|all is required");
  }
  if (all && scenarios.length > 0) {
    throw new Error("runner: pass either --all or a scenario list, not both");
  }
  if (!all && scenarios.length === 0) {
    throw new Error("runner: must pass --all or one or more scenario names");
  }
  return { channel, scenarios, all, iterations, maxFailures: maxFailures ?? 1 };
}

function parseChannel(raw: string | undefined): ChannelArg {
  if (raw !== "discord-mock" && raw !== "slack-mock" && raw !== "all") {
    throw new Error(
      `runner: --channel expects discord-mock|slack-mock|all, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function parseNonNegativeInt(raw: string | undefined, flag: string, min: number): number {
  if (raw === undefined || raw === "") {
    throw new Error(`runner: ${flag} expects an integer >= ${min}`);
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`runner: ${flag} expects an integer, got ${JSON.stringify(raw)}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`runner: ${flag} expects an integer >= ${min}, got ${JSON.stringify(raw)}`);
  }
  return n;
}
