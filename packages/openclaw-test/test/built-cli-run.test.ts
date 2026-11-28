import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPaths,
  consumer,
  downCalls,
  lastConfigPath,
  RUN_CASE,
  records,
  run,
  useBuiltCliFixtures,
} from "./built-cli-helpers.js";

useBuiltCliFixtures();

describe("built harness run", () => {
  it("runs parallel workers with captured output, Docker argv/env and one teardown each", () => {
    const fixture = consumer();
    const result = run(fixture, [
      "run",
      "--channel",
      "mock",
      "--model",
      "offline",
      "--parallel",
      "2",
      "first",
      "second",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const stamp = readdirSync(join(fixture.root, "artifacts"))[0];
    for (const scenario of ["first", "second"]) {
      const log = readFileSync(
        join(fixture.root, "artifacts", stamp, "cells", `offline-${scenario}-mock.log`),
        "utf8",
      );
      expect(log).toContain("FAKE_RUN_STDOUT");
      expect(log).toContain("FAKE_RUN_STDERR");
    }
    const up = records(fixture).find(
      (call) => call.args?.includes("up") && call.args.includes("project-w1"),
    );
    expect(up?.args?.slice(-6)).toEqual([
      "up",
      "-d",
      "--force-recreate",
      "--wait",
      "bus",
      "gateway",
    ]);
    expect(up?.workspace).toBe(join(fixture.root, ".workers", "w1", "workspace"));
    expect(up?.config).toContain("openclaw-test-config-");
    expect(up?.uid).toBe(String(process.getuid?.() ?? 1000));
    expect(downCalls(fixture)).toHaveLength(2);
    expect(existsSync(up?.config ?? "missing")).toBe(false);
  });

  it.each([0, 7])("preserves matrix exit %i across a failing teardown", (matrixExit) => {
    const fixture = consumer();
    const result = run(fixture, RUN_CASE, {
      FAKE_FAIL_DOWN: "9",
      FAKE_REMOVE_BEFORE_DOWN: "1",
      ...(matrixExit === 7 ? { FAKE_FAIL_UP: "7" } : {}),
    });
    expect(result.status, result.stderr).toBe(matrixExit === 0 ? 9 : matrixExit);
    const config = configPaths(fixture).at(-1);
    expect(config).toBeDefined();
    expect(existsSync(config ?? "missing")).toBe(true);
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config ?? "missing")).toBe(false);
  });

  it("joins and removes only new workers in a mixed warm/new run", () => {
    const fixture = consumer();
    expect(run(fixture, ["env", "up"]).status).toBe(0);
    const result = run(fixture, [
      "run",
      "--channel",
      "mock",
      "--model",
      "offline",
      "--parallel",
      "2",
      "first",
      "second",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const downs = downCalls(fixture);
    expect(downs).toHaveLength(1);
    expect(downs[0]?.args?.[downs[0].args.indexOf("-p") + 1]).toMatch(/-w2$/);
    const config = lastConfigPath(fixture);
    expect(existsSync(config)).toBe(true);
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it("sweeps warm configs on rebuild before creating and removing new workers", () => {
    const fixture = consumer();
    expect(run(fixture, ["env", "up", "--parallel", "2"]).status).toBe(0);
    const old = lastConfigPath(fixture);
    const result = run(fixture, RUN_CASE, { FAKE_BASE_MISSING: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(downCalls(fixture)).toHaveLength(3);
    expect(existsSync(old)).toBe(false);
    for (const path of configPaths(fixture)) expect(existsSync(path)).toBe(false);
  });

  it("retains secrets and aborts rebuild when the warm sweep fails", () => {
    const fixture = consumer();
    expect(run(fixture, ["env", "up"]).status).toBe(0);
    const config = lastConfigPath(fixture);
    const result = run(fixture, RUN_CASE, { FAKE_BASE_MISSING: "1", FAKE_FAIL_DOWN: "9" });
    expect(result.status).toBe(9);
    expect(existsSync(config)).toBe(true);
    expect(configPaths(fixture)).toEqual([config]);
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });
});
