import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerSubagent } from "../src/index.js";
import { launchManaged } from "../src/process-tree.js";
import provider from "./fixtures/provider.js";

const fixture = fileURLToPath(new URL("./fixtures/pi.mjs", import.meta.url));

describe.skipIf(process.platform !== "linux")("actual SDK extension lifecycle", () => {
  it("awaits synchronous-child cleanup during extension reload", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-reload-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "config"));
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("SUBAGENT_PARENT_TASK", "wait");
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: "subagent-fixture",
      defaultModel: "local",
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, "config"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
      extensionFactories: [
        provider,
        (pi) => registerSubagent(pi, async () => ({ command: process.execPath, args: [fixture] })),
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "config"),
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      tools: ["subagent"],
    });
    await session.bindExtensions({ mode: "json" });
    const model = session.modelRuntime.getModel("subagent-fixture", "local");
    if (model === undefined) throw new Error("Deterministic SDK provider was not registered.");
    await session.setModel(model);
    let promptError: unknown;
    const pending = session
      .prompt("Delegate the deterministic wait assignment.")
      .catch((error: unknown) => {
        promptError = error;
      });
    let pid: number | undefined;
    let identity: string | undefined;
    try {
      await waitFor(
        () => readdirSync(cwd).filter((file) => file.startsWith("capture-")).length === 2,
      );
      const file = readdirSync(cwd).find(
        (file) =>
          file.startsWith("capture-") &&
          readFileSync(join(cwd, file), "utf8").includes("Task:\\nwait\\nEnd of task."),
      );
      if (file === undefined) throw new Error("Waiting child not registered.");
      pid = Number(file.slice("capture-".length, -".json".length));
      const fields = processFields(pid);
      identity = fields?.[19];
      expect(identity).toBeDefined();
      await session.reload();
      expect(processFields(pid)?.[19] === identity && processFields(pid)?.[0] !== "Z").toBe(false);
      await session.abort();
      await pending;
      expect(promptError).toBeUndefined();
    } finally {
      if (
        pid !== undefined &&
        identity !== undefined &&
        processFields(pid)?.[19] === identity &&
        processFields(pid)?.[0] !== "Z"
      ) {
        process.kill(pid, "SIGKILL");
      }
      await session.abort();
      await pending.catch(() => {});
      session.dispose();
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);
  it("actual Pi parent shutdown awaits nested Pi/bash cleanup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-parent-shutdown-"));
    const config = join(dir, "config");
    const pids = join(dir, "pids");
    const cli = fileURLToPath(
      new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
    );
    const providerFile = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));
    const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    mkdirSync(config);
    mkdirSync(pids);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ extensions: [providerFile] }));
    let diagnostics = "";
    const managed = launchManaged({
      command: process.execPath,
      args: [
        cli,
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-extensions",
        "-e",
        providerFile,
        "-e",
        extension,
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
        "--offline",
        "--model",
        "subagent-fixture/local",
        "--tools",
        "subagent",
      ],
      cwd: dir,
      env: {
        ...process.env,
        HOME: dir,
        PI_CODING_AGENT_DIR: config,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        SUBAGENT_PARENT_TASK: "run the bash fixture",
        SUBAGENT_PARENT_SCOPE: "user",
        // Each child's bash records its PID, then becomes a long-running process.
        SUBAGENT_FIXTURE_COMMAND: `: > '${pids}'/$$; exec sleep 60`,
      },
      stdout: () => {},
      stderr(chunk) {
        diagnostics += chunk.toString();
      },
      inputError: () => {},
    });
    managed.child.stdin.end("Delegate the deterministic assignments.");
    const shells: { pid: number; identity: string }[] = [];
    let timer: NodeJS.Timeout | undefined;
    try {
      await managed.spawned;
      await waitFor(() => readdirSync(pids).length === 2).catch((error) => {
        throw new Error(`${error.message}\n${diagnostics}`);
      });
      for (const name of readdirSync(pids)) {
        const identity = processFields(Number(name))?.[19];
        if (identity === undefined) throw new Error("Nested bash exited before shutdown.");
        shells.push({ pid: Number(name), identity });
      }
      // Signal only the direct Pi parent: the extension alone must reach the nested work.
      managed.child.kill("SIGTERM");
      await Promise.race([
        managed.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Parent shutdown timed out:\n${diagnostics}`)),
            10_000,
          );
        }),
      ]);
      expect(shells.filter(isLive)).toEqual([]);
    } finally {
      clearTimeout(timer);
      for (const shell of shells) if (isLive(shell)) process.kill(shell.pid, "SIGKILL");
      await managed.stop(Date.now()).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

function isLive({ pid, identity }: { pid: number; identity: string }): boolean {
  const fields = processFields(pid);
  return fields?.[19] === identity && fields[0] !== "Z";
}

function processFields(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    )
      return;
    throw error;
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("SDK lifecycle fixture timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
