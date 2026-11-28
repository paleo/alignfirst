import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseDevArgs } from "../src/cli.js";
import { type DevServerConfig, runDevServer } from "../src/dev-server.js";
import { ConfigError, WorkspaceError } from "../src/errors.js";
import { isProcessAlive } from "../src/process-control.js";
import type { CallbackServer } from "../src/server-descriptor.js";
import { updateWorkspaces } from "../src/workspaces.js";
import {
  addWorktree,
  createKernelFixture,
  devEntries,
  devEntry,
  ownProcess,
  sleeper,
  writeDevEntries,
  type KernelFixture,
  registryDir,
  removeKernelFixtures,
  requiredEntry,
  runKernel,
} from "./kernel-fixture.js";

afterEach(removeKernelFixtures);

interface CallbackEvent {
  event: "start" | "stop";
  label: string;
  name: string;
  cwd: string;
  ports: Record<string, number>;
}

describe("dev startup settings", () => {
  it("rejects a startup override before claims, setup, file writes or stopping a live instance", async () => {
    const fx = createKernelFixture();
    let setups = 0;
    const config = devConfig({
      setup: () => void ++setups,
      runFiles: [{ path: "run.env", source: { kind: "content", content: "generated\n" } }],
      resolveStartSettings: () => {
        throw new ConfigError("Invalid maxConcurrentDevServers override.");
      },
    });
    const files = ["workspaces.json", "dev-servers.json", "dev-startups.json"]
      .map((name) => join(registryDir(fx), name))
      .concat(join(fx.repo, "run.env"));
    const bytes = () =>
      files.map((path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined));
    const before = bytes();
    await expect(dev(fx, config, ["up"])).rejects.toThrow(ConfigError);
    expect(bytes()).toEqual(before);
    expect(setups).toBe(0);
    await dev(fx, config, ["setup"]);
    const pid = sleeper();
    writeDevEntries(fx, [devEntry("app", fx.repo, pid)]);
    writeFileSync(join(fx.repo, "run.env"), "hand edited\n");
    const running = bytes();
    await expect(dev(fx, config, ["restart"])).rejects.toThrow(ConfigError);
    expect(isProcessAlive(pid)).toBe(true);
    expect(bytes()).toEqual(running);
    for (const args of [["status"], ["list"], ["down"], ["setup", "--force"]])
      await dev(fx, config, args);
    expect(isProcessAlive(pid)).toBe(false);
    expect(setups).toBe(2);
  });
});

describe("dev spawn servers", () => {
  it("keeps a package-cwd server's log under the root runtime with a URI-encoded label", async () => {
    const fx = createKernelFixture();
    mkdirSync(join(fx.repo, "packages/api"), { recursive: true });
    const config = devConfig({
      servers: [
        {
          kind: "spawn",
          name: "api/name",
          exec: {
            command: "sh",
            args: ["-c", "pwd; echo READY; exec sleep 600"],
            cwd: join(fx.repo, "packages/api"),
          },
          detectReady: (log) => log.includes("READY"),
        },
      ],
    });
    await dev(fx, config, ["up"]);
    const [entry] = devEntries(fx);
    ownProcess(entry.pids["api/name"]);
    expect(readFileSync(join(fx.repo, ".local-wt/logs/api%2Fname.log"), "utf8")).toContain(
      `${join(fx.repo, "packages/api")}\nREADY`,
    );
    await dev(fx, config, ["down"]);
    expect(isProcessAlive(entry.pids["api/name"])).toBe(false);
  });
});

describe("dev callbacks", () => {
  it("stops with current callbacks and recorded identity, without resolving startup commands", async () => {
    const fx = createKernelFixture();
    const linked = addWorktree(fx, "linked/review", "review");
    await runKernel(fx, ["setup"], { cwd: linked });
    const { name } = requiredEntry(fx, linked);
    const pid = sleeper();
    writeDevEntries(fx, [devEntry(name, linked, pid)]);
    await updateWorkspaces(fx.repo, registryDir(fx), (registry) => {
      delete registry.workspaces[name];
    });
    const events: CallbackEvent[] = [];
    const config = devConfig({
      servers: [
        callback("docker", events),
        callback("cache", events),
        {
          kind: "spawn",
          name: "ready",
          exec: () => {
            throw new Error("Startup command must not resolve on stop");
          },
          detectReady: () => true,
        },
      ],
    });
    await dev(fx, config, ["down"], linked);
    expect(events).toEqual(
      ["cache", "docker"].map((label) => ({ event: "stop", label, name, cwd: linked, ports: {} })),
    );
    expect(devEntries(fx)).toEqual([]);
    expect(isProcessAlive(pid)).toBe(false);
  });

  it.each([false, true])(
    "rolls back only started callbacks and retains a failed rollback for retry, stop failure=%s",
    async (failStop) => {
      const fx = createKernelFixture();
      const events: CallbackEvent[] = [];
      let stopFails = failStop;
      const config = devConfig({
        servers: [
          callback("docker", events, () => stopFails),
          {
            ...callback("cache", events, () => stopFails),
            start: async (ctx) => {
              events.push(event("start", "cache", ctx));
              throw new Error("cache start failed");
            },
          },
        ],
      });
      await expect(dev(fx, config, ["up"])).rejects.toThrow("cache start failed");
      expect(events.map(({ event, label }) => `${event} ${label}`)).toEqual([
        "start docker",
        "start cache",
        "stop docker",
      ]);
      if (!failStop) {
        expect(devEntries(fx)).toEqual([]);
        return;
      }
      expect(devEntries(fx)).toMatchObject([
        { name: "app", worktree: fx.repo, pids: {}, cleanupPending: true },
      ]);
      await expect(dev(fx, config, ["up"])).rejects.toThrow(WorkspaceError);
      stopFails = false;
      await dev(fx, config, ["down"]);
      expect(devEntries(fx)).toEqual([]);
      expect(events.filter((entry) => entry.event === "stop").map(({ label }) => label)).toEqual([
        "docker",
        "cache",
        "docker",
      ]);
    },
  );
});

function devConfig(overrides: Partial<DevServerConfig> = {}): DevServerConfig {
  return { recipe: { kind: "defaults" }, runtimeDir: ".local-wt", servers: [], ...overrides };
}

function dev(
  fx: KernelFixture,
  config: DevServerConfig,
  args: string[],
  cwd = fx.repo,
): Promise<void> {
  return runDevServer(config, { ...fx.operation, cwd, command: parseDevArgs(args) });
}

function callback(
  label: string,
  events: CallbackEvent[],
  stopFails: () => boolean = () => false,
): CallbackServer {
  return {
    kind: "callback",
    name: label,
    start: async (ctx) => {
      events.push(event("start", label, ctx));
    },
    stop: async (ctx) => {
      events.push(event("stop", label, ctx));
      if (stopFails()) throw new Error(`${label} stop failed`);
    },
  };
}

function event(
  kind: CallbackEvent["event"],
  label: string,
  ctx: { name: string; cwd: string; ports: Record<string, number> },
): CallbackEvent {
  return { event: kind, label, name: ctx.name, cwd: ctx.cwd, ports: ctx.ports };
}
