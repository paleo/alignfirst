import type * as FileSystem from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { launchManaged, psTarget } from "../src/process-tree.js";
import {
  type FixturePid,
  isLive,
  records,
  toolStarted,
  jsonEvents,
  waitFor,
} from "./process-tree-helpers.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof FileSystem>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

const TEST_GRACE_MS = 300;
const LATE_GRACE_MS = 1_500;
const fixture = fileURLToPath(new URL("./fixtures/tree.mjs", import.meta.url));

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

  it("actual Pi parent shutdown awaits this extension's nested Pi/bash cleanup", async () => {
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
    let output = "";
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
        SUBAGENT_FIXTURE_COMMAND: `'${process.execPath}' '${fixture}' '${dir}' grouped`,
      },
      stdout: (chunk) => {
        output += chunk.toString();
      },
      stderr(chunk) {
        diagnostics += chunk.toString();
      },
      inputError: () => {},
    });
    managed.child.stdin.end("Delegate the deterministic assignments.");
    let timer: NodeJS.Timeout | undefined;
    try {
      await managed.spawned;
      await waitFor(
        () => toolStarted(output, "subagent"),
        () => jsonEvents(output).length,
      ).catch((error) => {
        throw new Error(`${error.message}\n${diagnostics}`);
      });
      await waitFor(
        () => records(dir).length >= 6,
        () => records(dir).length,
      ).catch((error) => {
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
      const dir = mkdtempSync(join(tmpdir(), "pi-subagent-disappearance-"));
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

  // The leader's first stat read is the table scan; the second is the identity check before TERM.
  it.each([
    { code: "EACCES", stage: "pre-signal identity check", failingRead: 2 },
    { code: "EIO", stage: "process-table scan", failingRead: 1 },
  ])(
    "reports $code from the $stage, retains ownership, and permits retry",
    async ({ code, failingRead }) => {
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
        const original = vi.mocked(readFileSync).getMockImplementation();
        if (!original) throw new Error("Missing filesystem implementation.");
        let leaderReads = 0;
        vi.mocked(readFileSync).mockImplementation((...args) => {
          if (
            String(args[0]) === `/proc/${managed.child.pid}/stat` &&
            ++leaderReads === failingRead
          ) {
            throw Object.assign(new Error("inspection denied"), { code });
          }
          return original(...args);
        });
        const failed = managed.stop();
        try {
          expect(managed.stop()).toBe(failed);
          await expect(failed).rejects.toThrow("inspection denied");
        } finally {
          vi.mocked(readFileSync).mockImplementation(original);
        }
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

  it.each(["EPERM", "EACCES"])(
    "skips an unrelated process whose stat fails with %s",
    async (code) => {
      const dir = mkdtempSync(join(tmpdir(), "pi-subagent-hidden-"));
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
        let hiddenReads = 0;
        // The test runner's parent is always listed in /proc and is unrelated to the fixture.
        vi.mocked(readFileSync).mockImplementation((...args) => {
          if (String(args[0]) === `/proc/${process.ppid}/stat`) {
            ++hiddenReads;
            throw Object.assign(new Error("hidden process"), { code });
          }
          return original(...args);
        });
        try {
          await managed.stop();
        } finally {
          vi.mocked(readFileSync).mockImplementation(original);
        }
        expect(hiddenReads).toBeGreaterThan(0);
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

describe("macOS process query parsing", () => {
  it("reads a live record and keeps the start time as identity", () => {
    expect(psTarget("  412     1   412 Ss   Sat Oct 24 23:50:21 2026")).toEqual({
      pid: 412,
      ppid: 1,
      group: 412,
      identity: "Sat Oct 24 23:50:21 2026",
      zombie: false,
    });
  });

  it("marks a zombie record", () => {
    expect(psTarget("  913   412   412 Z+   Sat Oct 24 23:51:02 2026").zombie).toBe(true);
  });

  it("rejects a malformed record", () => {
    expect(() => psTarget("  913   412 Z+")).toThrow("Invalid process query record.");
  });
});
