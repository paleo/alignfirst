import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  alive,
  configPaths,
  consumer,
  downCalls,
  lastConfigPath,
  RUN_CASE,
  records,
  run,
  start,
  useBuiltCliFixtures,
  waitForOwnedProcesses,
  waitUntil,
} from "./built-cli-helpers.js";

useBuiltCliFixtures();

describe("built harness cancellation", () => {
  it("cancels a running cell, escalates its Docker children and still tears down", async () => {
    const fixture = consumer();
    const started = start(fixture, RUN_CASE, { FAKE_HANG: "run", FAKE_FAIL_DOWN: "9" });
    await waitUntil(() => started.output().includes("FAKE_RUNNING"));
    started.child.kill("SIGTERM");
    await started.closed;
    expect(started.child.exitCode, started.output()).toBe(143);
    expect(records(fixture).at(-1)?.args?.at(-1)).toBe("down");
    await waitForOwnedProcesses(fixture);
  });

  it("retains the signal during a mixed final teardown and joins every owned worker", async () => {
    const fixture = consumer();
    const started = start(
      fixture,
      ["run", "--channel", "mock", "--model", "offline", "--parallel", "2", "first", "second"],
      {
        FAKE_HANG: "down",
        FAKE_REMOVE_BEFORE_DOWN: "1",
        FAKE_HANG_WORKER: "2",
        FAKE_FAIL_DOWN: "9",
      },
    );
    await waitUntil(() => started.output().includes("FAKE_RUNNING"));
    const calls = downCalls(fixture);
    const configs = configPaths(fixture);
    expect(configs).toHaveLength(1);
    started.child.kill("SIGINT");
    await started.closed;
    expect(started.child.exitCode, started.output()).toBe(130);
    expect(calls).toHaveLength(2);
    for (const config of configs) expect(existsSync(config)).toBe(true);
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    for (const config of configs) expect(existsSync(config)).toBe(false);
    await waitForOwnedProcesses(fixture);
  });

  it("prioritizes a signal over a failed sibling during parallel env up", async () => {
    const fixture = consumer();
    const started = start(fixture, ["env", "up", "--parallel", "2"], {
      FAKE_HANG: "up",
      FAKE_HANG_WORKER: "2",
      FAKE_FAIL_UP: "7",
    });
    await waitUntil(() => started.output().includes("FAKE_RUNNING"));
    const ups = records(fixture).filter((call) => call.args?.includes("up"));
    expect(ups).toHaveLength(2);
    const failed = ups.find((call) => call.args?.includes("project-w1"));
    expect(failed?.pid).toBeDefined();
    await waitUntil(() => failed?.pid !== undefined && !alive(failed.pid));
    expect(started.output()).toContain("fake recreate failure");
    started.child.kill("SIGINT");
    await started.closed;
    expect(started.child.exitCode, started.output()).toBe(130);
    await waitForOwnedProcesses(fixture);
    const config = lastConfigPath(fixture);
    expect(existsSync(config)).toBe(true);
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it("cancels the rebuild sweep without collecting warm configs", async () => {
    const fixture = consumer();
    expect(run(fixture, ["env", "up", "--parallel", "2"]).status).toBe(0);
    const config = lastConfigPath(fixture);
    const started = start(fixture, RUN_CASE, {
      FAKE_HANG: "down",
      // Remove every mount before cancellation to expose premature config collection.
      FAKE_REMOVE_BEFORE_DOWN: "1",
      FAKE_BASE_MISSING: "1",
      FAKE_HANG_WORKER: "2",
      FAKE_FAIL_DOWN: "9",
    });
    await waitUntil(() => started.output().includes("FAKE_RUNNING"));
    const downs = downCalls(fixture);
    expect(downs.map((call) => call.args?.[call.args.indexOf("-p") + 1]).sort()).toEqual([
      "project-w1",
      "project-w2",
    ]);
    const failed = downs.find((call) => call.args?.includes("project-w1"));
    expect(failed?.pid).toBeDefined();
    await waitUntil(() => failed?.pid !== undefined && !alive(failed.pid));
    started.child.kill("SIGTERM");
    await started.closed;
    expect(started.child.exitCode, started.output()).toBe(143);
    const calls = records(fixture);
    expect(calls.filter((call) => call.worker !== undefined)).toHaveLength(1);
    await waitForOwnedProcesses(fixture);
    expect(configPaths(fixture)).toEqual([config]);
    expect(calls.some((call) => call.args?.includes("run"))).toBe(false);
    expect(existsSync(config)).toBe(true);
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });
});
