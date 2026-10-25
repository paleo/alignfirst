import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSubagent } from "../src/index.js";
import type { PiInvocation } from "../src/pi-process.js";
import { OutputSchema, type Parameters, type SubagentResult } from "../src/run.js";

const fixture = fileURLToPath(new URL("./fixtures/pi.mjs", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
});

describe("registered public subagent tool", () => {
  it("returns the declared structured schema and delivers literal task bytes through an envelope", async () => {
    const host = harness();
    for (const name of [
      "PI_SESSION_ID",
      "PI_SESSION_FILE",
      "PI_PROVIDER",
      "PI_MODEL",
      "PI_REASONING_LEVEL",
    ])
      vi.stubEnv(name, "stale-parent");
    vi.stubEnv("SUBAGENT_TEST_CREDENTIAL", "preserved-fixture-value");
    vi.stubEnv("PI_OFFLINE", "1");
    const task =
      "/skill:nonexistent\n/command $(touch SHOULD-NOT-EXIST); @file\n'\"\n日本語 😀  \n\t";
    const result = await host.tool.execute("literal", { task }, undefined, undefined, host.context);
    expect(result.isError).toBe(false);
    expect(Value.Check(OutputSchema, result.structuredContent)).toBe(true);
    expect(result.details?.results[0]).toMatchObject({
      agent: "worker",
      agentSource: "bundled",
      output: task,
      thinking: "high",
      status: "succeeded",
    });
    expect(result.usage?.totalTokens).toBe(5);
    const captures = host.captures();
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      input: `Task:\n${task}\nEnd of task.`,
      cwd: host.cwd,
      env: { SUBAGENT_TEST_CREDENTIAL: "preserved-fixture-value", PI_OFFLINE: "1" },
    });
    expect(Object.keys(captures[0].env)).toEqual(["PI_OFFLINE", "SUBAGENT_TEST_CREDENTIAL"]);
    expect(captures[0].args).toContain("--no-session");
    expect(captures[0].args).toContain("read,bash,edit,write");
    expect(captures[0].args).toContain("mcp__*");
    expect(captures[0].args).not.toContain("--approve");
    expect(existsSync(captures[0].promptPath)).toBe(false);
    expect(existsSync(join(host.cwd, "SHOULD-NOT-EXIST"))).toBe(false);
  });

  it.each(["error", "length", "malformed", "incomplete", "startup-error", "signal"])(
    "fails %s even if the protocol process exits zero",
    async (task) => {
      const host = harness();
      const result = await host.tool.execute(task, { task }, undefined, undefined, host.context);
      expect(result.isError).toBe(true);
      expect(result.details?.results[0].status).toBe("failed");
      expect(result.details?.results[0].error).toBeDefined();
    },
  );

  it("reports a missing executable as a failed result", async () => {
    const host = harness(async () => ({ command: "/absent/pi", args: [] }));
    const result = await host.tool.execute(
      "missing",
      { task: "work" },
      undefined,
      undefined,
      host.context,
    );
    expect(result.isError).toBe(true);
    expect(result.details?.results[0].error).toContain("ENOENT");
  });

  it("reports an invalid execution cwd without launching work elsewhere", async () => {
    const host = harness();
    const result = await host.tool.execute(
      "cwd",
      { task: "work", cwd: "missing-directory" },
      undefined,
      undefined,
      host.context,
    );
    expect(result.isError).toBe(true);
    expect(result.details?.results[0]).toMatchObject({
      status: "failed",
      cwd: join(host.cwd, "missing-directory"),
    });
    expect(host.captures()).toEqual([]);
  });

  it("reports a stdin EPIPE as a failed result", async () => {
    const host = harness(async () => ({ command: process.execPath, args: [fixture, "--epipe"] }));
    const result = await host.tool.execute(
      "epipe",
      { task: "x".repeat(8 * 1024 * 1024) },
      undefined,
      undefined,
      host.context,
    );
    expect(result.isError).toBe(true);
    expect(result.details?.results[0].error).toMatch(/EPIPE|I\/O/);
  });

  it("awaits all parallel children on per-call abort and never spawns queued work", async () => {
    const host = harness();
    const abort = new AbortController();
    const pending = host.tool.execute(
      "abort",
      { tasks: Array.from({ length: 8 }, () => ({ task: "wait" })) },
      abort.signal,
      undefined,
      host.context,
    );
    await waitFor(() => host.captures().length === 4);
    abort.abort();
    const result = await pending;
    expect(result.details?.results).toHaveLength(8);
    expect(result.details?.results.every((task) => task.status === "cancelled")).toBe(true);
    expect(host.captures()).toHaveLength(4);
  });

  it.each(["session_shutdown", "session_start", "session_tree"])(
    "retires active children on %s",
    async (event) => {
      const host = harness();
      const pending = host.tool.execute(
        "lifecycle",
        { task: "wait" },
        undefined,
        undefined,
        host.context,
      );
      await waitFor(() => host.captures().length === 1);
      await host.emit(event, { oldLeafId: "old", newLeafId: "new" });
      const result = await pending;
      expect(result.details?.results[0].status).toBe("cancelled");
      const next = await host.tool.execute(
        "next",
        { task: "new owner" },
        undefined,
        undefined,
        host.context,
      );
      expect(next.isError).toBe(false);
    },
  );

  it("does not cancel for a picker/pre-tree event or unchanged successful target", async () => {
    const host = harness();
    const abort = new AbortController();
    const pending = host.tool.execute(
      "picker",
      { task: "wait" },
      abort.signal,
      undefined,
      host.context,
    );
    await waitFor(() => host.captures().length === 1);
    await host.emit("session_before_tree", {});
    await host.emit("session_tree", { oldLeafId: "same", newLeafId: "same" });
    const next = await host.tool.execute(
      "still-current",
      { task: "works" },
      undefined,
      undefined,
      host.context,
    );
    expect(next.isError).toBe(false);
    abort.abort();
    expect((await pending).details?.results[0].status).toBe("cancelled");
  });

  it("does not let newly created host resources manufacture project-profile trust", async () => {
    const host = harness();
    host.context.isProjectTrusted = () => true;
    await host.emit("session_start", {});
    mkdirSync(join(host.cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(host.cwd, ".pi", "settings.json"), "{}");
    writeFileSync(
      join(host.cwd, ".pi", "agents", "worker.md"),
      "---\nname: worker\ndescription: fixture\n---\nUnapproved prompt",
    );
    await expect(
      host.tool.execute(
        "trust",
        { task: "work", agentScope: "both" },
        undefined,
        undefined,
        host.context,
      ),
    ).rejects.toThrow("/trust");
    expect(host.captures()).toEqual([]);
  });

  it("checks owner generation after awaited launch preparation", async () => {
    let resolve!: (invocation: PiInvocation) => void;
    const deferred = new Promise<PiInvocation>((done) => {
      resolve = done;
    });
    const host = harness(() => deferred);
    const pending = host.tool.execute(
      "late",
      { task: "must not launch" },
      undefined,
      undefined,
      host.context,
    );
    let retired = false;
    const shutdown = host.emit("session_shutdown", {}).then(() => {
      retired = true;
    });
    await new Promise((done) => setTimeout(done, 10));
    expect(retired).toBe(false);
    resolve({ command: process.execPath, args: [fixture] });
    await shutdown;
    const result = await pending;
    expect(result.details?.results[0].status).toBe("cancelled");
    expect(host.captures()).toEqual([]);
  });
});

interface Capture {
  input: string;
  cwd: string;
  args: string[];
  promptPath: string;
  env: Record<string, string>;
}

function harness(
  invocation: () => Promise<PiInvocation> = async () => ({
    command: process.execPath,
    args: [fixture],
  }),
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-tool-"));
  const agentDir = join(cwd, "user");
  mkdirSync(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  let registered: unknown;
  const handlers = new Map<string, unknown>();
  const api = {
    registerTool(tool: unknown) {
      registered = tool;
    },
    on(name: string, handler: unknown) {
      handlers.set(name, handler);
    },
  };
  // Deliberately partial host double: these are the only registration APIs the extension may use.
  registerSubagent(api as unknown as ExtensionAPI, invocation);
  // Registration erases the tool's generic arguments at the unknown boundary above.
  const tool = registered as ToolDefinition<typeof Parameters, SubagentResult | undefined>;
  // The execution fixture supplies only the context fields consumed by this tool.
  const context = {
    cwd,
    model: undefined,
    thinkingLevel: "high",
    isProjectTrusted: () => false,
  } as ExtensionToolContext;
  const emit = async (event: string, data: unknown) => {
    const handler = handlers.get(event);
    if (typeof handler === "function") await handler(data, context);
  };
  cleanups.push(async () => {
    await emit("session_shutdown", {});
    rmSync(cwd, { recursive: true, force: true });
  });
  return {
    tool,
    context,
    cwd,
    emit,
    captures: (): Capture[] =>
      readdirSync(cwd)
        .filter((file) => file.startsWith("capture-"))
        .map((file) => JSON.parse(readFileSync(join(cwd, file), "utf8"))),
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Tool fixture synchronization timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
