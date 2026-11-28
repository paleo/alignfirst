import type * as FileSystem from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as subagentCopy from "../../pi-subagent/src/process-tree.js";
import * as backgroundCopy from "../src/process-tree.js";
import { type FixturePid, isLive, records, waitFor } from "./process-tree-helpers.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof FileSystem>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

const TEST_GRACE_MS = 300;
const LATE_GRACE_MS = 1_000;
const fixture = fileURLToPath(new URL("./fixtures/tree.mjs", import.meta.url));

type ProcessTree = typeof backgroundCopy;
type ManagedProcess = ReturnType<ProcessTree["launchManaged"]>;

// Each package keeps its own copy so it installs alone; both copies must pass the same suite.
const copies: { name: string; tree: ProcessTree }[] = [
  { name: "pi-background", tree: backgroundCopy },
  { name: "pi-subagent", tree: subagentCopy },
];

describe.each(copies)("$name process tree", ({ tree: { launchManaged, psTarget } }) => {
  describe.skipIf(process.platform !== "linux")("real process cleanup gate", () => {
    it.concurrent.each(["cooperative", "ignoring", "grouped", "natural", "closed", "late"])(
      "reaps the leader and terminates %s descendants",
      async (mode) => {
        const dir = mkdtempSync(join(tmpdir(), "pi-process-tree-"));
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
          await release(dir, managed);
        }
      },
      8_000,
    );

    it.concurrent("cleans actual Pi print-mode bash and its separately grouped grandchild", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-process-tree-host-"));
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
        if (shell && isLive(shell)) process.kill(shell.pid, "SIGKILL");
        await release(dir, managed);
      }
    }, 15_000);

    it("tolerates a process vanishing during inspection and before its signal", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-process-tree-vanished-"));
      const managed = await startCooperative(dir);
      const original = readFileImplementation();
      const kill = vi.spyOn(process, "kill");
      try {
        let queryRace = false;
        let leaderReads = 0;
        vi.mocked(readFileSync).mockImplementation((...args) => {
          const path = String(args[0]);
          if (path === `/proc/${process.pid}/stat` && !queryRace) {
            queryRace = true;
            throw Object.assign(new Error("process disappeared during query"), { code: "ENOENT" });
          }
          if (path === `/proc/${managed.child.pid}/stat` && ++leaderReads === 2) {
            throw Object.assign(new Error("process disappeared before signal"), {
              code: "ENOENT",
            });
          }
          return original(...args);
        });
        await managed.stop(Date.now());
        expect(queryRace).toBe(true);
        expect(leaderReads).toBeGreaterThanOrEqual(2);
        expect(kill).not.toHaveBeenCalledWith(managed.child.pid, "SIGTERM");
        expect(records(dir).filter(isLive)).toEqual([]);
        expect(managed.child.exitCode !== null || managed.child.signalCode !== null).toBe(true);
      } finally {
        vi.mocked(readFileSync).mockImplementation(original);
        kill.mockRestore();
        await release(dir, managed);
      }
    });

    // The leader's first stat read is the table scan; the second is the identity check before TERM.
    it.each([
      { code: "EACCES", stage: "pre-signal identity check", failingRead: 2 },
      { code: "EIO", stage: "process-table scan", failingRead: 1 },
    ])(
      "reports $code from the $stage, retains ownership, and permits retry",
      async ({ code, failingRead }) => {
        const dir = mkdtempSync(join(tmpdir(), "pi-process-tree-query-failure-"));
        const managed = await startCooperative(dir);
        const original = readFileImplementation();
        try {
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
          const failed = managed.stop(Date.now() + TEST_GRACE_MS);
          expect(managed.stop()).toBe(failed);
          await expect(failed).rejects.toThrow("inspection denied");
          vi.mocked(readFileSync).mockImplementation(original);
          expect(records(dir).some(isLive)).toBe(true);
          const retry = managed.stop(Date.now() + TEST_GRACE_MS);
          expect(retry).not.toBe(failed);
          await retry;
          expect(records(dir).filter(isLive)).toEqual([]);
        } finally {
          vi.mocked(readFileSync).mockImplementation(original);
          await release(dir, managed);
        }
      },
    );

    it.each([
      { stat: "unreadable", read: hiddenStat("EPERM") },
      // Linux output for a task being reaped, once its signal handlers are released.
      {
        stat: "a reaping record",
        read: (pid: number) =>
          `${pid} (sh) Z 0 -1 -1 0 -1 4227084 110 455 0 0 0 0 0 0 20 0 0 0 1263055 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 17 13 0 0 0 0 0 0\n`,
      },
    ])("skips an unrelated process whose stat is $stat", async ({ read }) => {
      const dir = mkdtempSync(join(tmpdir(), "pi-process-tree-hidden-"));
      const managed = await startCooperative(dir);
      const original = readFileImplementation();
      try {
        let hiddenReads = 0;
        // The test runner's parent is always listed in /proc and is unrelated to the fixture.
        vi.mocked(readFileSync).mockImplementation((...args) => {
          if (String(args[0]) === `/proc/${process.ppid}/stat`) {
            ++hiddenReads;
            return read(process.ppid);
          }
          return original(...args);
        });
        await managed.stop(Date.now() + TEST_GRACE_MS);
        vi.mocked(readFileSync).mockImplementation(original);
        expect(hiddenReads).toBeGreaterThan(0);
        expect(records(dir).filter(isLive)).toEqual([]);
      } finally {
        vi.mocked(readFileSync).mockImplementation(original);
        await release(dir, managed);
      }
    });

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
        ).toThrow();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("separates spawn failure from a zero exit", async () => {
      const managed = launchManaged({
        command: "/missing/process-tree-executable",
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

    async function startCooperative(dir: string): Promise<ManagedProcess> {
      const managed = launchManaged({
        command: process.execPath,
        args: [fixture, dir, "cooperative"],
        cwd: dir,
        stdout: () => {},
        stderr: () => {},
        inputError: () => {},
      });
      await managed.spawned;
      await waitFor(() => records(dir).length === 2);
      return managed;
    }
  });

  it("parses macOS process query records with the start time as identity", () => {
    expect(psTarget("  412     1   412 Ss   Sat Oct 24 23:50:21 2026")).toEqual({
      pid: 412,
      ppid: 1,
      group: 412,
      identity: "Sat Oct 24 23:50:21 2026",
      zombie: false,
    });
    expect(psTarget("  913   412   412 Z+   Sat Oct 24 23:51:02 2026").zombie).toBe(true);
    expect(() => psTarget("  913   412 Z+")).toThrow();
  });
});

function readFileImplementation() {
  const original = vi.mocked(readFileSync).getMockImplementation();
  if (!original) throw new Error("Missing filesystem implementation.");
  return original;
}

// Independently verified identities keep a failed assertion from leaking fixtures.
async function release(dir: string, managed: ManagedProcess): Promise<void> {
  for (const record of records(dir)) if (isLive(record)) process.kill(record.pid, "SIGKILL");
  await managed.stop(Date.now()).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

function hiddenStat(code: string): () => never {
  return () => {
    throw Object.assign(new Error("hidden process"), { code });
  };
}
