export interface RunnerArgs {
  scenario: string;
  channel: string;
  modelId: string;
  modelRef: string;
  iterationIndex: number;
  iterationWidth: number;
  baseStamp: string;
  resultsDir: string;
}

export function parseArgs(argv: string[]): RunnerArgs {
  let scenario: string | undefined;
  let channel: string | undefined;
  let modelId: string | undefined;
  let modelRef: string | undefined;
  let iterationIndex: number | undefined;
  let iterationWidth: number | undefined;
  let baseStamp: string | undefined;
  let resultsDir: string | undefined;

  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i] as string;
    const eat = (flag: string): string => {
      if (a === flag) return argv[++i] ?? "";
      return a.slice(`${flag}=`.length);
    };
    if (a === "--scenario" || a.startsWith("--scenario=")) {
      scenario = eat("--scenario");
    } else if (a === "--channel" || a.startsWith("--channel=")) {
      channel = eat("--channel");
    } else if (a === "--model-id" || a.startsWith("--model-id=")) {
      modelId = eat("--model-id");
    } else if (a === "--model-ref" || a.startsWith("--model-ref=")) {
      modelRef = eat("--model-ref");
    } else if (a === "--iteration-index" || a.startsWith("--iteration-index=")) {
      iterationIndex = parseNonNegativeInt(eat("--iteration-index"), "--iteration-index", 1);
    } else if (a === "--iteration-width" || a.startsWith("--iteration-width=")) {
      iterationWidth = parseNonNegativeInt(eat("--iteration-width"), "--iteration-width", 0);
    } else if (a === "--base-stamp" || a.startsWith("--base-stamp=")) {
      baseStamp = eat("--base-stamp");
    } else if (a === "--results-dir" || a.startsWith("--results-dir=")) {
      resultsDir = eat("--results-dir");
    } else {
      throw new Error(`runner: unknown argument: ${a}`);
    }
  }

  if (!scenario) throw new Error("runner: --scenario <id> is required");
  if (!channel) throw new Error("runner: --channel <id> is required");
  if (!modelId) throw new Error("runner: --model-id <id> is required");
  if (!modelRef) throw new Error("runner: --model-ref <ref> is required");
  if (iterationIndex === undefined) throw new Error("runner: --iteration-index <n> is required");
  if (iterationWidth === undefined) throw new Error("runner: --iteration-width <w> is required");
  if (!baseStamp) throw new Error("runner: --base-stamp <iso> is required");
  if (!resultsDir) throw new Error("runner: --results-dir <path> is required");

  return {
    scenario,
    channel,
    modelId,
    modelRef,
    iterationIndex,
    iterationWidth,
    baseStamp,
    resultsDir,
  };
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
