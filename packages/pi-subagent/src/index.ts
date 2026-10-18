import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { PiInvocation } from "./pi-process.js";
import type { ManagedProcess } from "./process-tree.js";
import { dispatch, OutputSchema, Parameters, type SubagentResult } from "./run.js";

interface Owner {
  retired: boolean;
  calls: Set<LiveCall>;
  processes: Set<ManagedProcess>;
  cleanupDeadline?: number;
  trustedProject?: string;
}

interface LiveCall {
  controller: AbortController;
  done: Promise<void>;
}

export default function subagent(pi: ExtensionAPI): void {
  registerSubagent(pi);
}

export function registerSubagent(pi: ExtensionAPI, invocation?: () => Promise<PiInvocation>): void {
  let owner = newOwner();
  const unresolved = new Set<Owner>();
  const retire = async () => {
    const previous = owner;
    previous.retired = true;
    unresolved.add(previous);
    owner = newOwner();
    const deadline = Date.now() + 5_000;
    const stops: Promise<void>[] = [];
    for (const old of unresolved) {
      old.cleanupDeadline = deadline;
      for (const call of old.calls) {
        call.controller.abort();
        stops.push(call.done);
      }
      for (const child of old.processes) {
        stops.push(
          child.stop(deadline).then(() => {
            old.processes.delete(child);
          }),
        );
      }
    }
    const results = await Promise.allSettled(stops);
    for (const old of unresolved) if (old.processes.size === 0) unresolved.delete(old);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Subagent lifecycle cleanup failed; ownership retained for retry.",
      );
  };
  pi.on("session_shutdown", retire);
  pi.on("session_start", (_event, ctx) => {
    const established = ctx.isProjectTrusted() && hasTrustRequiringProjectResources(ctx.cwd);
    const cleanup = retire();
    if (established) owner.trustedProject = ctx.cwd;
    return cleanup;
  });
  pi.on("session_tree", async (event) => {
    if (event.newLeafId === event.oldLeafId) return;
    const trustedProject = owner.trustedProject;
    const cleanup = retire();
    owner.trustedProject = trustedProject;
    await cleanup;
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate isolated synchronous Pi assignments. Use task, tasks (max eight; four concurrent), " +
      "or chain with {previous}. Omitted agent selects the bundled worker. Children share files, not the parent " +
      "conversation. Project profiles require explicit trusted scope. Do not detach work or launch daemons. " +
      "Results total at most 50 KiB; request an explicit project file for larger deliverables.",
    parameters: Parameters,
    outputSchema: OutputSchema,
    async execute(
      _id,
      params,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<SubagentResult | undefined>> {
      const captured = owner;
      const controller = new AbortController();
      let cancellationDeadline: number | undefined;
      const abort = () => {
        cancellationDeadline ??= Date.now() + 5_000;
        controller.abort();
      };
      let complete!: () => void;
      const call: LiveCall = {
        controller,
        done: new Promise<void>((resolve) => {
          complete = resolve;
        }),
      };
      captured.calls.add(call);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || captured.retired) abort();
      const active = () => owner === captured && !captured.retired;
      try {
        const result = await dispatch(params, {
          cwd: ctx.cwd,
          model: ctx.model === undefined ? undefined : `${ctx.model.provider}/${ctx.model.id}`,
          thinking: ctx.thinkingLevel,
          trusted:
            params.agentScope === undefined || params.agentScope === "user"
              ? ctx.isProjectTrusted()
              : projectTrustEstablished(ctx, captured),
          signal: controller.signal,
          active,
          invocation,
          deadline: () => captured.cleanupDeadline ?? cancellationDeadline,
          own(child) {
            captured.processes.add(child);
          },
          release(child) {
            captured.processes.delete(child);
          },
          progress(text) {
            if (active() && !controller.signal.aborted)
              onUpdate?.({ content: [{ type: "text", text }], details: undefined });
          },
        });
        return {
          content: [{ type: "text", text: result.text }],
          details: result.data,
          structuredContent: result.data,
          usage: result.usage,
          isError: result.isError,
        };
      } finally {
        captured.calls.delete(call);
        signal?.removeEventListener("abort", abort);
        complete();
      }
    },
    renderCall(args) {
      return new Text(
        `subagent ${args.tasks !== undefined ? "parallel" : args.chain !== undefined ? "chain" : "single"}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }) {
      const block = result.content.find((content) => content.type === "text");
      const text = block?.type === "text" ? block.text : "Subagent finished.";
      return new Text(expanded ? text : text.split("\n").slice(0, 8).join("\n"), 0, 0);
    },
  });
}

function projectTrustEstablished(ctx: ExtensionContext, owner: Owner): boolean {
  if (!ctx.isProjectTrusted()) return false;
  // Pi auto-trusts bare .pi/agents. Only the startup snapshot may certify host-gated resources;
  // creating a settings file during a turn must not manufacture trust.
  return (
    owner.trustedProject === ctx.cwd || new ProjectTrustStore(getAgentDir()).get(ctx.cwd) === true
  );
}

function newOwner(): Owner {
  return { retired: false, calls: new Set(), processes: new Set() };
}
