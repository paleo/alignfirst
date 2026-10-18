import { resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { discoverAgents } from "./agents.js";
import { addUsage, bounded, emptyUsage } from "./json-output.js";
import { type PiAssignment, type PiOutcome, type PiProcessOptions, runPi } from "./pi-process.js";

const NonBlank = Type.String({ pattern: "\\S" });
const Thinking = Type.Union(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)),
);
const Task = Type.Object(
  {
    task: NonBlank,
    agent: Type.Optional(NonBlank),
    cwd: Type.Optional(NonBlank),
    model: Type.Optional(NonBlank),
    thinking: Type.Optional(Thinking),
  },
  { additionalProperties: false },
);
export const Parameters = Type.Object(
  {
    task: Type.Optional(NonBlank),
    agent: Type.Optional(NonBlank),
    cwd: Type.Optional(NonBlank),
    tasks: Type.Optional(Type.Array(Task, { minItems: 1, maxItems: 8 })),
    chain: Type.Optional(Type.Array(Task, { minItems: 1 })),
    model: Type.Optional(NonBlank),
    thinking: Type.Optional(Thinking),
    agentScope: Type.Optional(
      Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")]),
    ),
  },
  { additionalProperties: false },
);
const UsageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  totalTokens: Type.Number(),
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});
export const OutputSchema = Type.Object({
  mode: Type.Union([Type.Literal("single"), Type.Literal("parallel"), Type.Literal("chain")]),
  results: Type.Array(
    Type.Object({
      agent: Type.String(),
      agentSource: Type.Union([
        Type.Literal("bundled"),
        Type.Literal("user"),
        Type.Literal("project"),
      ]),
      cwd: Type.String(),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
      status: Type.Union([
        Type.Literal("succeeded"),
        Type.Literal("failed"),
        Type.Literal("cancelled"),
      ]),
      exitCode: Type.Optional(Type.Number()),
      signal: Type.Optional(Type.String()),
      output: Type.String(),
      truncated: Type.Boolean(),
      error: Type.Optional(Type.String()),
      usage: UsageSchema,
    }),
  ),
});

export type SubagentResult = Static<typeof OutputSchema>;

export interface DispatchContext extends PiProcessOptions {
  cwd: string;
  model?: string;
  thinking?: string;
  trusted: boolean;
  agentDir?: string;
  progress?: (text: string) => void;
  runner?: (assignment: PiAssignment, options: PiProcessOptions) => Promise<PiOutcome>;
}

export interface DispatchResult {
  data: SubagentResult;
  text: string;
  usage: Usage;
  isError: boolean;
}

export async function dispatch(input: unknown, context: DispatchContext): Promise<DispatchResult> {
  if (!Value.Check(Parameters, input))
    throw new Error(
      "Invalid subagent parameters. Use nonblank strings and nonempty task collections (parallel maximum: eight).",
    );
  const modes = [input.task, input.tasks, input.chain].filter(
    (value) => value !== undefined,
  ).length;
  if (
    modes !== 1 ||
    (input.task === undefined && (input.agent !== undefined || input.cwd !== undefined))
  ) {
    throw new Error(
      "Provide exactly one mode: task (optional agent/cwd), tasks, or chain. Do not mix single-only fields into a collection.",
    );
  }
  const mode =
    input.tasks !== undefined ? "parallel" : input.chain !== undefined ? "chain" : "single";
  const source = input.tasks ??
    input.chain ?? [{ task: input.task ?? "", agent: input.agent, cwd: input.cwd }];
  const profile = discoverAgents({
    cwd: context.cwd,
    trusted: context.trusted,
    scope: input.agentScope ?? "user",
    agentDir: context.agentDir,
  });
  const assignments = source.map((task): PiAssignment => {
    const agent = profile(task.agent ?? "worker");
    return {
      profile: agent,
      task: task.task,
      cwd: resolve(context.cwd, task.cwd ?? "."),
      model: task.model ?? input.model ?? agent.model ?? context.model,
      thinking: task.thinking ?? input.thinking ?? context.thinking,
    };
  });
  // Bound retained result metadata without imposing an arbitrary chain length.
  if (
    Buffer.byteLength(
      JSON.stringify(
        assignments.map(({ task: _task, profile, ...settings }) => ({
          ...settings,
          agent: profile.name,
          source: profile.source,
        })),
      ),
    ) >
    128 * 1024
  )
    throw new Error(
      "Subagent result metadata exceeds the 128 KiB invocation budget. Split this invocation.",
    );
  const outcomes: PiOutcome[] = new Array(assignments.length);
  const retainedBudget = Math.floor((40 * 1024) / assignments.length);
  const diagnosticBudget = Math.floor((8 * 1024) / assignments.length);
  const run = async (index: number, task?: string): Promise<PiOutcome> => {
    const assignment = assignments[index];
    if (context.signal.aborted || !context.active()) {
      outcomes[index] = {
        status: "cancelled",
        output: "",
        truncated: false,
        usage: emptyUsage(),
        error: "Cancelled before dispatch.",
      };
      return outcomes[index];
    }
    let outcome: PiOutcome;
    try {
      outcome = await (context.runner ?? runPi)(
        { ...assignment, task: task ?? assignment.task },
        context,
      );
    } catch (error) {
      outcome = {
        status: "failed",
        output: "",
        truncated: false,
        usage: emptyUsage(),
        error: bounded(error instanceof Error ? error.message : String(error), 4096).text,
      };
    }
    const retained = bounded(outcome.output, retainedBudget);
    outcomes[index] = {
      ...outcome,
      output: retained.text,
      truncated: outcome.truncated || retained.truncated,
      error:
        outcome.error === undefined ? undefined : bounded(outcome.error, diagnosticBudget).text,
    };
    if (context.active())
      context.progress?.(
        `Subagent: ${outcomes.filter(Boolean).length}/${assignments.length} finished.`,
      );
    return outcome;
  };
  if (mode === "chain") {
    let previous = "";
    for (let index = 0; index < assignments.length; ++index) {
      const outcome = await run(
        index,
        assignments[index].task.replaceAll("{previous}", () => previous),
      );
      if (outcome.status !== "succeeded") break;
      if (index + 1 < assignments.length && outcome.truncated) {
        outcomes[index].status = "failed";
        outcomes[index].error =
          "Chain stopped: predecessor output was truncated; write larger handoffs to an explicit project file.";
        break;
      }
      previous = outcome.output;
    }
  } else {
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(mode === "parallel" ? 4 : 1, assignments.length) },
        async () => {
          while (next < assignments.length) {
            const index = next++;
            await run(index);
          }
        },
      ),
    );
  }
  return renderResults(mode, assignments, outcomes);
}

function renderResults(
  mode: SubagentResult["mode"],
  assignments: PiAssignment[],
  outcomes: PiOutcome[],
): DispatchResult {
  const completed = outcomes.filter((outcome) => outcome !== undefined);
  const count = Math.max(1, completed.length);
  const diagnosticBudget = Math.floor((8 * 1024) / count);
  const diagnostics = completed.map((outcome) =>
    outcome.error === undefined ? undefined : bounded(outcome.error, diagnosticBudget),
  );
  const overhead = completed.reduce(
    (bytes, outcome, index) =>
      bytes +
      Buffer.byteLength(
        `### Task ${index + 1}: ${outcome.status} [truncated]\n${diagnostics[index]?.text ?? ""}\n\n\n`,
      ),
    0,
  );
  const headingsOverflow = overhead > 50 * 1024 - 128;
  const outputBudget = headingsOverflow
    ? 0
    : Math.floor(Math.min(40 * 1024, 50 * 1024 - overhead) / count);
  const usage = emptyUsage();
  const results = completed.map((outcome, index) => {
    const assignment = assignments[index];
    const output = bounded(outcome.output, outputBudget);
    addUsage(usage, outcome.usage);
    return {
      agent: assignment.profile.name,
      agentSource: assignment.profile.source,
      cwd: assignment.cwd,
      model: assignment.model,
      thinking: assignment.thinking,
      status: outcome.status,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      output: output.text,
      truncated:
        outcome.truncated ||
        output.truncated ||
        diagnostics[index]?.truncated === true ||
        headingsOverflow,
      error: diagnostics[index]?.text,
      usage: outcome.usage,
    };
  });
  const text = headingsOverflow
    ? `All ${results.length} task outputs were truncated: result headings exceed the 50 KiB display budget. Task statuses remain in structuredContent.`
    : bounded(
        results
          .map(
            (result, index) =>
              `### Task ${index + 1}: ${result.status}${result.truncated ? " [truncated]" : ""}\n${result.output}${result.error === undefined ? "" : `\n${result.error}`}`,
          )
          .join("\n\n"),
        50 * 1024,
      ).text;
  return {
    data: { mode, results },
    text,
    usage,
    isError: results.some((result) => result.status !== "succeeded"),
  };
}
