import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPaths,
  consumer,
  lastConfigPath,
  run,
  useBuiltCliFixtures,
} from "./built-cli-helpers.js";

useBuiltCliFixtures();

describe("built harness state root and config ownership", () => {
  it.each(["direct", "symlink"])("rejects %s state root inside the build context", (kind) => {
    const fixture = consumer();
    const privateState = join(fixture.root, "private-state");
    mkdirSync(privateState);
    let stateHome = privateState;
    if (kind === "symlink") {
      stateHome = join(dirname(fixture.root), "linked-state");
      symlinkSync(privateState, stateHome);
    }
    const result = run(fixture, ["env", "up"], { XDG_STATE_HOME: stateHome });
    expect(result.status).toBe(1);
    expect(readdirSync(privateState)).toEqual([]);
  });

  it.each(["relative", "symlink", "public", "writable"])(
    "rejects an unsafe %s state directory",
    (kind) => {
      const fixture = consumer();
      const stateHome = fixture.env.XDG_STATE_HOME;
      const home = fixture.env.HOME;
      if (stateHome === undefined || home === undefined) {
        throw new Error("Missing isolated state home");
      }
      mkdirSync(stateHome, { recursive: true, mode: 0o700 });
      const appRoot = join(stateHome, "openclaw-test");
      if (kind === "symlink") symlinkSync(home, appRoot);
      if (kind === "public") mkdirSync(appRoot, { mode: 0o755 });
      if (kind === "writable") chmodSync(stateHome, 0o777);
      const result = run(fixture, ["env", "up"], {
        XDG_STATE_HOME: kind === "relative" ? "relative-state" : stateHome,
      });
      expect(result.status).toBe(1);
      expect(configPaths(fixture)).toEqual([]);
    },
  );

  it("collects only configs with matching ownership", () => {
    const fixture = consumer();
    const sibling = consumer();
    sibling.env.XDG_STATE_HOME = fixture.env.XDG_STATE_HOME;
    expect(run(fixture, ["env", "up"]).status).toBe(0);
    expect(run(sibling, ["env", "up"]).status).toBe(0);
    const own = lastConfigPath(fixture);
    const other = lastConfigPath(sibling);
    expect(dirname(dirname(own))).not.toBe(dirname(dirname(other)));
    writeFileSync(
      join(dirname(own), "owner.json"),
      JSON.stringify({
        projectDir: sibling.root,
        pid: 99999999,
      }),
    );
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(own)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(run(sibling, ["env", "down"]).status).toBe(0);
    expect(existsSync(other)).toBe(false);
  });

  it("retains another live command's unmounted configs", () => {
    const fixture = consumer();
    expect(run(fixture, ["env", "up"]).status).toBe(0);
    const config = lastConfigPath(fixture);
    const ownerFile = join(dirname(config), "owner.json");
    const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
    writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: process.pid }));
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(true);
    writeFileSync(ownerFile, JSON.stringify(owner));
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it("retains configs of another Docker daemon or when discovery fails", () => {
    const fixture = consumer();
    expect(run(fixture, ["env", "up"]).status).toBe(0);
    const config = lastConfigPath(fixture);
    expect(run(fixture, ["env", "down"], { FAKE_DAEMON_ID: "other" }).status).toBe(0);
    expect(existsSync(config)).toBe(true);
    expect(run(fixture, ["env", "down"], { FAKE_FAIL_LS: "1" }).status).toBe(1);
    expect(existsSync(config)).toBe(true);
    expect(run(fixture, ["env", "down"], { FAKE_FAIL_INFO: "1" }).status).toBe(0);
    expect(existsSync(config)).toBe(true);
    expect(run(fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });
});
