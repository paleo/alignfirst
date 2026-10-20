import type * as FileSystem from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { launchManaged } from "../src/process-tree.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof FileSystem>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

const TEST_GRACE_MS = 300;
const LATE_GRACE_MS = 1_500;
const fixture = fileURLToPath(new URL("./fixtures/tree.mjs", import.meta.url));

interface FixturePid {
  pid: number;
  identity: string;
  role: string;
}

describe.skipIf(process.platform !== "linux")("real process cleanup gate", () => {
  it.each(["cooperative", "ignoring", "grouped", "natural", "closed", "late"])(
    "reaps the leader and terminates %s descendants",
    async (mode) => {
      const dir = mkdtempSync(join(tmpdir(), "pi-subagent-tree-"));
      const errors: Error[] = [];
      const managed = launchManaged({
        command: process.execPath,
        args: [fixture, dir, mode],
        cwd: dir,
        stdout: () => {},
        stderr: () => {},
        inputError: (error) => errors.push(error),
      });
      try {
        expect(await managed.spawned).toBeUndefined();
        await waitFor(
          () => records(dir).length >= (mode === "grouped" ? 3 : mode === "late" ? 1 : 2),
        );
        if (mode === "natural" || mode === "closed") {
          writeFileSync(join(dir, "exit"), "exit");
          expect((await managed.exited).code).toBe(0);
          expect(records(dir).some(isLive)).toBe(true);
        }
        const start = Date.now();
        const stop = managed.stop(Date.now() + (mode === "late" ? LATE_GRACE_MS : TEST_GRACE_MS));
        expect(managed.stop()).toBe(stop);
        await stop;
        expect(Date.now() - start).toBeLessThan(4_000);
        await managed.closed;
        await managed.exited;
        expect(managed.child.exitCode !== null || managed.child.signalCode !== null).toBe(true);
        if (mode === "late") expect(records(dir).length).toBeGreaterThanOrEqual(3);
        expect(records(dir).filter(isLive)).toEqual([]);
        expect(errors).toEqual([]);
        await managed.stop();
      } finally {
        // Independently verified identities keep a failed assertion from leaking fixtures.
        for (const record of records(dir)) {
          if (isLive(record)) process.kill(record.pid, "SIGKILL");
        }
        await managed.stop(Date.now()).catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    },
    8_000,
  );

  it("cleans actual Pi print-mode bash and its separately grouped grandchild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-host-"));
    const cli = fileURLToPath(
      new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
    );
    const provider = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));
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
        provider,
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
        "--offline",
        "--model",
        "subagent-fixture/local",
        "--tools",
        "bash",
      ],
      cwd: dir,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(dir, "config"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        SUBAGENT_FIXTURE_COMMAND: `printf '%s' "$BASHPID" > shell.pid; '${process.execPath}' '${fixture}' '${dir}' grouped`,
      },
      stdout: () => {},
      stderr: (chunk) => {
        diagnostics += chunk.toString();
      },
      inputError: () => {},
    });
    managed.child.stdin.end("Task:\nRun the deterministic fixture.");
    let shell: FixturePid | undefined;
    try {
      expect(await managed.spawned).toBeUndefined();
      await waitFor(() => records(dir).length >= 3).catch((error) => {
        throw new Error(`${error.message}\n${diagnostics}`);
      });
      const pid = Number(readFileSync(join(dir, "shell.pid"), "utf8"));
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      shell = { pid, identity: fields[19], role: "bash" };
      expect(Number(fields[2])).not.toBe(managed.child.pid);
      await managed.stop(Date.now() + TEST_GRACE_MS);
      expect(records(dir).filter(isLive)).toEqual([]);
      expect(isLive(shell)).toBe(false);
      expect(managed.child.exitCode !== null || managed.child.signalCode !== null).toBe(true);
    } finally {
      for (const record of [...records(dir), ...(shell ? [shell] : [])]) {
        if (isLive(record)) process.kill(record.pid, "SIGKILL");
      }
      await managed.stop(Date.now()).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("actual Pi parent shutdown awaits this extension's background Pi/bash cleanup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-parent-shutdown-"));
    const config = join(dir, "config");
    const cli = fileURLToPath(
      new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
    );
    const provider = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));
    const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    mkdirSync(config);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ extensions: [provider] }));
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
        provider,
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
        "background",
      ],
      cwd: dir,
      env: {
        ...process.env,
        HOME: dir,
        PI_CODING_AGENT_DIR: config,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        BACKGROUND_PARENT_COMMAND: `'${process.execPath}' '${cli}' --mode json -p --no-session --no-extensions -e '${provider}' --no-skills --no-prompt-templates --no-context-files --no-themes --offline --model subagent-fixture/local --tools bash 'Run the deterministic fixture.'`,
        SUBAGENT_FIXTURE_COMMAND: `'${process.execPath}' '${fixture}' '${dir}' grouped`,
      },
      stdout: () => {},
      stderr(chunk) {
        diagnostics += chunk.toString();
      },
      inputError: () => {},
    });
    managed.child.stdin.end("Delegate the deterministic assignments.");
    let timer: NodeJS.Timeout | undefined;
    try {
      await managed.spawned;
      await waitFor(() => records(dir).length >= 3).catch((error) => {
        throw new Error(`${error.message}\n${diagnostics}`);
      });
      const started = Date.now();
      // Signal only the acknowledged direct Pi parent. The outer helper must not mask extension failures.
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
      expect(records(dir).filter(isLive)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(8_000);
      await managed.closed;
    } finally {
      clearTimeout(timer);
      for (const record of records(dir)) if (isLive(record)) process.kill(record.pid, "SIGKILL");
      await managed.stop(Date.now()).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it.each(["ENOENT", "ESRCH"])(
    "tolerates %s during inspection and pre-signal identity checks",
    async (code) => {
      const dir = mkdtempSync(join(tmpdir(), "pi-background-disappearance-"));
      const managed = launchManaged({
        command: process.execPath,
        args: [fixture, dir, "cooperative"],
        cwd: dir,
        stdout: () => {},
        stderr: () => {},
        inputError: () => {},
      });
      try {
        await managed.spawned;
        await waitFor(() => records(dir).length === 2);
        const original = vi.mocked(readFileSync).getMockImplementation();
        if (!original) throw new Error("Missing filesystem implementation.");
        let queryRace = false;
        let leaderReads = 0;
        const kill = vi.spyOn(process, "kill");
        vi.mocked(readFileSync).mockImplementation((...args) => {
          const path = String(args[0]);
          if (path === `/proc/${process.pid}/stat` && !queryRace) {
            queryRace = true;
            throw Object.assign(new Error("process disappeared during query"), { code });
          }
          if (path === `/proc/${managed.child.pid}/stat` && ++leaderReads === 2) {
            throw Object.assign(new Error("process disappeared before signal"), { code });
          }
          return original(...args);
        });
        try {
          await managed.stop(Date.now());
          expect(queryRace).toBe(true);
          expect(leaderReads).toBeGreaterThanOrEqual(2);
          expect(kill).not.toHaveBeenCalledWith(managed.child.pid, "SIGTERM");
          expect(records(dir).filter(isLive)).toEqual([]);
          expect(managed.child.exitCode !== null || managed.child.signalCode !== null).toBe(true);
        } finally {
          vi.mocked(readFileSync).mockImplementation(original);
          kill.mockRestore();
        }
      } finally {
        for (const record of records(dir)) if (isLive(record)) process.kill(record.pid, "SIGKILL");
        await managed.stop(Date.now()).catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["EACCES", "EIO"])(
    "reports %s inspection failure, retains ownership, and permits retry",
    async (code) => {
      const dir = mkdtempSync(join(tmpdir(), "pi-subagent-query-failure-"));
      const managed = launchManaged({
        command: process.execPath,
        args: [fixture, dir, "cooperative"],
        cwd: dir,
        stdout: () => {},
        stderr: () => {},
        inputError: () => {},
      });
      try {
        await managed.spawned;
        await waitFor(() => records(dir).length === 2);
        vi.mocked(readFileSync).mockImplementationOnce(() => {
          throw Object.assign(new Error("inspection denied"), { code });
        });
        const failed = managed.stop();
        expect(managed.stop()).toBe(failed);
        await expect(failed).rejects.toThrow("inspection denied");
        expect(records(dir).some(isLive)).toBe(true);
        const retry = managed.stop();
        expect(retry).not.toBe(failed);
        await retry;
        expect(records(dir).filter(isLive)).toEqual([]);
      } finally {
        for (const record of records(dir)) if (isLive(record)) process.kill(record.pid, "SIGKILL");
        await managed.stop(Date.now()).catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    },
    12_000,
  );

  it("rejects native Windows before launching", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    try {
      expect(() =>
        launchManaged({
          command: "/must/not/launch",
          args: [],
          cwd: tmpdir(),
          stdout: () => {},
          stderr: () => {},
          inputError: () => {},
        }),
      ).toThrow("WSL");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("separates spawn failure from a zero exit", async () => {
    const managed = launchManaged({
      command: "/missing/subagent-executable",
      args: [],
      cwd: tmpdir(),
      stdout: () => {},
      stderr: () => {},
      inputError: () => {},
    });
    expect(await managed.spawned).toBeInstanceOf(Error);
    expect((await managed.exited).code).toBeNull();
    await managed.stop();
  });
});

function records(dir: string): FixturePid[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        !("pid" in value) ||
        !("identity" in value) ||
        !("role" in value) ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 1 ||
        typeof value.identity !== "string" ||
        typeof value.role !== "string"
      )
        throw new Error("Invalid fixture PID record.");
      return { pid: value.pid, identity: value.identity, role: value.role };
    });
}

function isLive(record: FixturePid): boolean {
  try {
    const stat = readFileSync(`/proc/${record.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] === record.identity && fields[0] !== "Z";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Fixture synchronization timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
