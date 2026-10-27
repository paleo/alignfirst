// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Manifest expressions are literal fixtures.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDevServer, toCallbackStartupError, watchForExternalStop } from "../src/dev-server.js";
import { StartupError } from "../src/errors.js";
import { handleStartupFailure } from "../src/log-polling.js";
import { adaptWorkspaceManifest } from "../src/manifest-adapter.js";

describe("watchForExternalStop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once all watched pids are dead", () => {
    const alive = new Set([10, 20]);
    const onStopped = vi.fn();
    watchForExternalStop([10, 20], onStopped, (pid) => alive.has(pid), 100);

    vi.advanceTimersByTime(100);
    expect(onStopped).not.toHaveBeenCalled();

    alive.delete(10);
    vi.advanceTimersByTime(100);
    expect(onStopped).not.toHaveBeenCalled();

    alive.delete(20);
    vi.advanceTimersByTime(100);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("stops polling after firing", () => {
    const onStopped = vi.fn();
    watchForExternalStop([10], onStopped, () => false, 100);
    vi.advanceTimersByTime(300);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("no-ops with no pids", () => {
    const onStopped = vi.fn();
    const timer = watchForExternalStop([], onStopped, () => true, 100);
    vi.advanceTimersByTime(1000);
    expect(onStopped).not.toHaveBeenCalled();
    expect(timer).toBeUndefined();
  });
});

describe("startup failure log location", () => {
  it("keeps a root-resolved absolute log path in both background and foreground reports", () => {
    const root = mkdtempSync(join(tmpdir(), "dev-log-test-"));
    const log = join(root, "ready.log");
    writeFileSync(log, "startup failed\n");
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const includeTail of [true, false]) {
        report.mockClear();
        handleStartupFailure(new StartupError("ready", "failed", log), { includeTail });
        expect(report.mock.calls.flat().join("\n")).toContain(`Full log: ${log}`);
      }
    } finally {
      report.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolved application launch", () => {
  it("spawns the late-bound command in package cwd with ABI env, while logs stay under the root", async () => {
    const root = mkdtempSync(join(tmpdir(), "resolved-launch-"));
    execFileSync("git", ["init", "-q", root]);
    const argv = process.argv;
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { devServer } = adaptWorkspaceManifest(
      {
        schemaVersion: 1,
        devServer: {
          setup: [
            {
              name: "prepare package",
              run: [
                process.execPath,
                "-e",
                "const fs=require('fs');fs.mkdirSync('packages/api',{recursive:true});fs.writeFileSync('prepared','yes');fs.writeFileSync('setup-context.json',process.env.ALIGNFIRST_CONTEXT)",
              ],
            },
          ],
          servers: [
            {
              kind: "spawn",
              name: "api/name",
              ready: { log: "READY" },
              exec: {
                cwd: "packages/api",
                env: { VALUE: "${{ name }}" },
                run: [
                  process.execPath,
                  "-e",
                  "if(require('fs').readFileSync('../../prepared','utf8')!=='yes')process.exit(2);console.log(JSON.stringify({cwd:process.cwd(),value:process.env.VALUE}));console.log('READY');setInterval(()=>{},1000)",
                ],
              },
            },
            {
              kind: "spawn",
              name: "__proto__",
              ready: { log: "READY" },
              exec: {
                run: [process.execPath, "-e", "console.log('READY');setInterval(()=>{},1000)"],
              },
            },
          ],
          summary: { command: { run: "printf '%s' \"$ALIGNFIRST_CONTEXT\"" } },
        },
      },
      { mainWorktree: root },
    );
    if (!devServer) throw new Error("Missing dev adapter");
    try {
      process.argv = [process.execPath, join(root, "dev.mjs"), "up"];
      await runDevServer(devServer);
      const logFile = join(root, ".local-wt/logs/api%2Fname.log");
      expect(readFileSync(logFile, "utf8")).toContain(
        JSON.stringify({ cwd: join(root, "packages/api"), value: root.split("/").at(-1) }),
      );
      expect(JSON.parse(readFileSync(join(root, "setup-context.json"), "utf8"))).toMatchObject({
        force: false,
        verbose: false,
      });
      const summary = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      expect(summary.currentWorktree).toBe(root);
      expect(summary.servers).toEqual([
        { name: "api/name", kind: "spawn", pid: expect.any(Number), logFile },
        {
          name: "__proto__",
          kind: "spawn",
          pid: expect.any(Number),
          logFile: join(root, ".local-wt/logs/__proto__.log"),
        },
      ]);
      process.argv = [process.execPath, join(root, "dev.mjs"), "setup", "--force", "--verbose"];
      await runDevServer(devServer);
      expect(JSON.parse(readFileSync(join(root, "setup-context.json"), "utf8"))).toMatchObject({
        phase: "devSetup",
        force: true,
        verbose: true,
        ports: {},
      });
    } finally {
      process.argv = [process.execPath, join(root, "dev.mjs"), "down"];
      await runDevServer(devServer);
      process.argv = argv;
      cwd.mockRestore();
      output.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("toCallbackStartupError", () => {
  it("wraps an Error's message under the server name", () => {
    const err = toCallbackStartupError("docker", new Error("compose failed"));
    expect(err).toBeInstanceOf(StartupError);
    expect(err.label).toBe("docker");
    expect(err.reason).toBe("compose failed");
    expect(err.logFile).toBeUndefined();
  });

  it("stringifies a non-Error throw", () => {
    expect(toCallbackStartupError("docker", "boom").reason).toBe("boom");
  });

  it("passes an existing StartupError through unchanged", () => {
    const original = new StartupError("docker", "compose failed", "/tmp/docker.log");
    const err = toCallbackStartupError("api", original);
    expect(err).toBe(original);
  });
});
