import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPaths,
  consumer,
  downCalls,
  lastConfigPath,
  RUN_CASE,
  run,
  useBuiltCliFixtures,
} from "./built-cli-helpers.js";

useBuiltCliFixtures();

describe("built harness runtime configs", () => {
  it("keeps warm configs across repeated runs and collects superseded secrets", () => {
    const fixture = consumer();
    expect(run(fixture, ["env", "up"]).status).toBe(0);
    const first = lastConfigPath(fixture);
    expect(existsSync(first)).toBe(true);
    expect(statSync(first).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(first)).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(dirname(first))).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(dirname(dirname(first)))).mode & 0o777).toBe(0o700);
    expect(statSync(join(dirname(first), "owner.json")).mode & 0o777).toBe(0o600);
    expect(first.startsWith(`${fixture.env.XDG_STATE_HOME}/openclaw-test/`)).toBe(true);
    expect(readFileSync(first, "utf8")).toContain("private-test-secret");
    expect(first.startsWith(fixture.root)).toBe(false);
    expect(run(fixture, RUN_CASE).status).toBe(0);
    const second = lastConfigPath(fixture);
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(run(fixture, RUN_CASE).status).toBe(0);
    const third = lastConfigPath(fixture);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(third)).toBe(true);
    expect(downCalls(fixture)).toHaveLength(0);
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(third)).toBe(false);
  });

  it("discovers configs under a symlinked state ancestor across TMPDIR changes", () => {
    const fixture = consumer();
    const physical = join(dirname(fixture.root), "physical-state");
    const linked = join(dirname(fixture.root), "linked-parent");
    mkdirSync(physical, { mode: 0o700 });
    symlinkSync(physical, linked);
    fixture.env.XDG_STATE_HOME = join(linked, "state");
    const temps = ["up-tmp", "run-tmp", "down-tmp"].map((name) =>
      join(dirname(fixture.root), name),
    );
    for (const temp of temps) mkdirSync(temp);
    expect(run(fixture, ["env", "up"], { TMPDIR: temps[0] }).status).toBe(0);
    const first = lastConfigPath(fixture);
    rmSync(temps[0], { recursive: true });
    expect(existsSync(first)).toBe(true);
    const result = run(fixture, RUN_CASE, { TMPDIR: temps[1] });
    expect(result.status, result.stderr).toBe(0);
    const second = lastConfigPath(fixture);
    expect(second).not.toBe(first);
    expect(dirname(dirname(first))).toBe(dirname(dirname(second)));
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(downCalls(fixture)).toHaveLength(0);
    rmSync(temps[1], { recursive: true });
    expect(run(fixture, ["env", "down"], { TMPDIR: temps[2] }).status).toBe(0);
    for (const config of configPaths(fixture)) expect(existsSync(config)).toBe(false);
  });

  it("retains configs when a container's mounts cannot be read", () => {
    const fixture = consumer();
    expect(run(fixture, ["env", "up"]).status).toBe(0);
    const first = lastConfigPath(fixture);
    expect(run(fixture, RUN_CASE, { FAKE_MALFORMED_INSPECT: "1" }).status).toBe(0);
    expect(existsSync(first)).toBe(true);
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    for (const path of configPaths(fixture)) expect(existsSync(path)).toBe(false);
  });

  it("retains stopped and external container references after successful down", () => {
    const fixture = consumer();
    expect(run(fixture, ["env", "up"]).status).toBe(0);
    const config = lastConfigPath(fixture);
    const stateDir = join(fixture.root, "docker-state");
    const stateName = readdirSync(stateDir)[0];
    if (stateName === undefined) throw new Error("Missing container state");
    const stateFile = join(stateDir, stateName);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.running = false;
    writeFileSync(stateFile, JSON.stringify(state));
    expect(run(fixture, ["env", "down"], { FAKE_KEEP_CONTAINERS: "1" }).status).toBe(0);
    expect(existsSync(config)).toBe(true);
    // A stopped unrelated container can also reference the config's parent directory.
    writeFileSync(
      join(stateDir, "external.json"),
      JSON.stringify({
        Id: "external",
        project: "external",
        running: false,
        Mounts: [{ Type: "bind", Source: dirname(config) }],
      }),
    );
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(true);
    rmSync(join(stateDir, "external.json"));
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });
});
