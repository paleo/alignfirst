import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSubagent } from "../src/index.js";
import type { PiInvocation } from "../src/pi-process.js";
import type { Parameters, SubagentResult } from "../src/run.js";

const fixture = fileURLToPath(new URL("./fixtures/pi.mjs", import.meta.url));
const fixtureInvocation = async (): Promise<PiInvocation> => ({
  command: process.execPath,
  args: [fixture],
});
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
});

describe("registered public subagent tool", () => {
  it("scrubs session metadata and delivers literal task bytes through an envelope", async () => {
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
    expect(result.details?.results[0].output).toBe(task);
    const captures = host.captures();
    expect(captures).toHaveLength(1);
    expect(captures[0].env).toEqual({
      PI_OFFLINE: "1",
      SUBAGENT_TEST_CREDENTIAL: "preserved-fixture-value",
    });
    expect(existsSync(join(host.cwd, "SHOULD-NOT-EXIST"))).toBe(false);
  });

  it.each([
    { failure: "startup error", task: "startup-error", invocation: fixtureInvocation },
    { failure: "signal", task: "signal", invocation: fixtureInvocation },
    {
      failure: "missing executable",
      task: "work",
      invocation: async () => ({ command: "/absent/pi", args: [] }),
    },
    {
      failure: "stdin EPIPE",
      task: "x".repeat(8 * 1024 * 1024),
      invocation: async () => ({ command: process.execPath, args: [fixture, "--epipe"] }),
    },
  ])("reports a $failure as a failed result", async ({ task, invocation }) => {
    const host = harness({ invocation });
    const result = await host.tool.execute("failure", { task }, undefined, undefined, host.context);
    expect(result.isError).toBe(true);
    expect(result.details?.results[0].status).toBe("failed");
    expect(result.details?.results[0].error).toBeDefined();
  });

  it("launches the installed Pi CLI under the parent runtime, not the first node on PATH", async () => {
    const host = harness({});
    const pi = join(host.cwd, "installed-pi");
    const bin = join(host.cwd, "bin");
    mkdirSync(pi);
    mkdirSync(bin);
    writeFileSync(
      join(pi, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "cli.mjs" } }),
    );
    symlinkSync(fixture, join(pi, "cli.mjs"));
    writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
    vi.stubEnv("PI_PACKAGE_DIR", pi);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const result = await host.tool.execute(
      "installed",
      { task: "probe" },
      undefined,
      undefined,
      host.context,
    );
    expect(result.isError).toBe(false);
    expect(host.captures()[0].runtime).toBe(process.execPath);
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
    ).rejects.toThrow();
    expect(host.captures()).toEqual([]);
  });

  it("checks owner generation after awaited launch preparation", async () => {
    let resolve!: (invocation: PiInvocation) => void;
    const deferred = new Promise<PiInvocation>((done) => {
      resolve = done;
    });
    const host = harness({ invocation: () => deferred });
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
  runtime: string;
  env: Record<string, string>;
}

// Without an invocation, the extension resolves the installed Pi package as in production.
function harness(
  { invocation }: { invocation?: () => Promise<PiInvocation> } = { invocation: fixtureInvocation },
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
