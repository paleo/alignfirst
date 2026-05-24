export type ChannelSelection = { kind: "all" } | { kind: "list"; ids: string[] };

export interface RunnerArgs {
  channelSelection: ChannelSelection;
  scenarios: string[];
  all: boolean;
  iterations: number;
  maxFailures: number;
}

export function parseArgs(argv: string[]): RunnerArgs {
  let channelSelection: ChannelSelection | undefined;
  let all = false;
  const scenarios: string[] = [];
  let iterations = 1;
  let maxFailures: number | undefined;
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i] as string;
    if (a === "--channel") {
      channelSelection = parseChannel(argv[++i]);
    } else if (a.startsWith("--channel=")) {
      channelSelection = parseChannel(a.slice("--channel=".length));
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
  if (channelSelection === undefined) {
    throw new Error("runner: --channel <id|id,id,…|all> is required");
  }
  if (all && scenarios.length > 0) {
    throw new Error("runner: pass either --all or a scenario list, not both");
  }
  if (!all && scenarios.length === 0) {
    throw new Error("runner: must pass --all or one or more scenario names");
  }
  return { channelSelection, scenarios, all, iterations, maxFailures: maxFailures ?? 1 };
}

function parseChannel(raw: string | undefined): ChannelSelection {
  if (raw === undefined || raw === "") {
    throw new Error("runner: --channel expects a non-empty value");
  }
  if (raw === "all") return { kind: "all" };
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new Error(`runner: --channel expects a non-empty list, got ${JSON.stringify(raw)}`);
  }
  return { kind: "list", ids };
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
