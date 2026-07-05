import { describe, expect, it } from "vitest";

import { parseDevArgs, parseWorkspaceArgs } from "../src/cli.js";
import { ConfigError } from "../src/errors.js";

describe("parseWorkspaceArgs", () => {
  it("parses bare `setup`", () => {
    const { command } = parseWorkspaceArgs(["setup"]);
    expect(command).toMatchObject({ kind: "setup", branch: undefined, newBranch: false });
  });

  it("parses `setup <branch>` as an existing branch", () => {
    const { command } = parseWorkspaceArgs(["setup", "feat/42"]);
    expect(command).toMatchObject({ kind: "setup", branch: "feat/42", newBranch: false });
  });

  it("parses `setup <branch> -c` as a new branch", () => {
    const { command } = parseWorkspaceArgs(["setup", "feat/42", "-c"]);
    expect(command).toMatchObject({ kind: "setup", branch: "feat/42", newBranch: true });
  });

  it("threads setup flags", () => {
    const { command, verbose } = parseWorkspaceArgs([
      "setup",
      "feat/42",
      "--slot",
      "8110",
      "--force",
      "--go",
      "--verbose",
    ]);
    expect(command).toEqual({
      kind: "setup",
      branch: "feat/42",
      newBranch: false,
      from: undefined,
      slot: "8110",
      force: true,
      go: true,
    });
    expect(verbose).toBe(true);
  });

  it("rejects the removed `-v` verbose short on a subcommand", () => {
    expect(() => parseWorkspaceArgs(["setup", "feat/42", "-v"])).toThrow(ConfigError);
  });

  it("parses `-v` and `--version` as the version command", () => {
    expect(parseWorkspaceArgs(["-v"]).command).toEqual({ kind: "version" });
    expect(parseWorkspaceArgs(["--version"]).command).toEqual({ kind: "version" });
  });

  it("rejects the removed `--wait` flag on setup", () => {
    expect(() => parseWorkspaceArgs(["setup", "feat/42", "--wait"])).toThrow(ConfigError);
  });

  it("rejects the removed `--owner` flag on setup", () => {
    expect(() => parseWorkspaceArgs(["setup", "feat/42", "--owner", "alice"])).toThrow(ConfigError);
  });

  it("parses `setup <branch> -c --from <ref>`", () => {
    const { command } = parseWorkspaceArgs([
      "setup",
      "feat/456",
      "-c",
      "--from",
      "origin/feat/123",
    ]);
    expect(command).toMatchObject({
      kind: "setup",
      branch: "feat/456",
      newBranch: true,
      from: "origin/feat/123",
    });
  });

  it("rejects `--from` without `-c`", () => {
    expect(() => parseWorkspaceArgs(["setup", "feat/456", "--from", "origin/feat/123"])).toThrow(
      ConfigError,
    );
  });

  it("rejects `-c` without a branch", () => {
    expect(() => parseWorkspaceArgs(["setup", "-c"])).toThrow(ConfigError);
  });

  it("parses `setup <branch> -c --go`", () => {
    const { command } = parseWorkspaceArgs(["setup", "feat/42", "-c", "--go"]);
    expect(command).toMatchObject({ kind: "setup", branch: "feat/42", newBranch: true, go: true });
  });

  it("rejects `--go` without a branch", () => {
    expect(() => parseWorkspaceArgs(["setup", "--go"])).toThrow(ConfigError);
  });

  it("rejects an unknown flag on setup", () => {
    expect(() => parseWorkspaceArgs(["setup", "--nope"])).toThrow(ConfigError);
  });

  it("rejects extra positionals on setup", () => {
    expect(() => parseWorkspaceArgs(["setup", "a", "b"])).toThrow(ConfigError);
  });

  it("parses `remove` without a selector", () => {
    const { command } = parseWorkspaceArgs(["remove"]);
    expect(command).toEqual({
      kind: "remove",
      selector: { dir: undefined, slot: undefined },
      force: false,
    });
  });

  it("parses `remove <dir> --force`", () => {
    const { command } = parseWorkspaceArgs(["remove", "../my-wt", "--force"]);
    expect(command).toEqual({
      kind: "remove",
      selector: { dir: "../my-wt", slot: undefined },
      force: true,
    });
  });

  it("parses `remove --slot <port>`", () => {
    const { command } = parseWorkspaceArgs(["remove", "--slot", "8110"]);
    expect(command).toEqual({
      kind: "remove",
      selector: { dir: undefined, slot: "8110" },
      force: false,
    });
  });

  it("rejects `remove <dir> --slot` together", () => {
    expect(() => parseWorkspaceArgs(["remove", "../my-wt", "--slot", "8110"])).toThrow(ConfigError);
  });

  it("rejects the removed `--no-remote-check` flag", () => {
    expect(() => parseWorkspaceArgs(["remove", "--no-remote-check"])).toThrow(ConfigError);
  });

  it("rejects the removed `set-owner` command", () => {
    expect(() => parseWorkspaceArgs(["set-owner", "alice"])).toThrow(ConfigError);
  });

  it("parses `list`", () => {
    const { command } = parseWorkspaceArgs(["list"]);
    expect(command).toEqual({ kind: "list" });
  });

  it("parses `prune`", () => {
    expect(parseWorkspaceArgs(["prune"]).command).toEqual({ kind: "prune" });
  });

  it("rejects `prune` with a positional", () => {
    expect(() => parseWorkspaceArgs(["prune", "feat/42"])).toThrow(ConfigError);
  });

  it("parses `status`, `status <dir>` and `status --slot`", () => {
    expect(parseWorkspaceArgs(["status"]).command).toEqual({
      kind: "status",
      selector: { dir: undefined, slot: undefined },
    });
    expect(parseWorkspaceArgs(["status", "../my-wt"]).command).toEqual({
      kind: "status",
      selector: { dir: "../my-wt", slot: undefined },
    });
    expect(parseWorkspaceArgs(["status", "--slot", "8110"]).command).toEqual({
      kind: "status",
      selector: { dir: undefined, slot: "8110" },
    });
  });

  it("rejects `status <dir> --slot` together", () => {
    expect(() => parseWorkspaceArgs(["status", "../my-wt", "--slot", "8110"])).toThrow(ConfigError);
  });

  it("parses `wait`", () => {
    expect(parseWorkspaceArgs(["wait"]).command).toEqual({
      kind: "wait",
      selector: { dir: undefined, slot: undefined },
    });
  });

  it("parses `migrate-0.16 <old-registry-dir>`", () => {
    const { command } = parseWorkspaceArgs(["migrate-0.16", ".local/_workspace-registry"]);
    expect(command).toEqual({ kind: "migrate", oldRegistryDir: ".local/_workspace-registry" });
  });

  it("rejects `migrate-0.16` without a positional", () => {
    expect(() => parseWorkspaceArgs(["migrate-0.16"])).toThrow(ConfigError);
  });

  it("rejects an unknown subcommand", () => {
    expect(() => parseWorkspaceArgs(["frobnicate"])).toThrow(ConfigError);
  });

  it("throws for no command, returns help for --help", () => {
    expect(() => parseWorkspaceArgs([])).toThrow(ConfigError);
    expect(parseWorkspaceArgs(["--help"]).command).toEqual({ kind: "help" });
  });

  it("returns guide for --guide", () => {
    expect(parseWorkspaceArgs(["--guide"]).command).toEqual({ kind: "guide" });
  });
});

describe("parseDevArgs", () => {
  it("treats bare invocation as foreground", () => {
    expect(parseDevArgs([])).toEqual({ kind: "foreground", evict: false, restart: false });
  });

  it("parses foreground flags", () => {
    expect(parseDevArgs(["--evict"])).toEqual({ kind: "foreground", evict: true, restart: false });
    expect(parseDevArgs(["--restart"])).toEqual({
      kind: "foreground",
      evict: false,
      restart: true,
    });
  });

  it("parses `up` with flags", () => {
    expect(parseDevArgs(["up"])).toEqual({ kind: "up", evict: false, restart: false });
    expect(parseDevArgs(["up", "--evict"])).toEqual({ kind: "up", evict: true, restart: false });
    expect(parseDevArgs(["up", "--restart"])).toEqual({
      kind: "up",
      evict: false,
      restart: true,
    });
  });

  it("parses `restart` with `--evict`", () => {
    expect(parseDevArgs(["restart"])).toEqual({ kind: "restart", evict: false });
    expect(parseDevArgs(["restart", "--evict"])).toEqual({ kind: "restart", evict: true });
  });

  it("rejects `--restart` on `restart`", () => {
    expect(() => parseDevArgs(["restart", "--restart"])).toThrow(ConfigError);
  });

  it("parses `down` and `down --all`", () => {
    expect(parseDevArgs(["down"])).toEqual({ kind: "down", all: false });
    expect(parseDevArgs(["down", "--all"])).toEqual({ kind: "down", all: true });
  });

  it("parses `list`", () => {
    expect(parseDevArgs(["list"])).toEqual({ kind: "list" });
  });

  it("parses `status`", () => {
    expect(parseDevArgs(["status"])).toEqual({ kind: "status" });
  });

  it("rejects positionals on `status`", () => {
    expect(() => parseDevArgs(["status", "x"])).toThrow(ConfigError);
  });

  it("parses `--help` / `-h`", () => {
    expect(parseDevArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseDevArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("rejects `--guide` (only `workspace --guide` prints the guide)", () => {
    expect(() => parseDevArgs(["--guide"])).toThrow(ConfigError);
  });

  it("rejects an unknown subcommand", () => {
    expect(() => parseDevArgs(["bogus"])).toThrow(ConfigError);
  });

  it("rejects an unknown flag on `up`", () => {
    expect(() => parseDevArgs(["up", "--nope"])).toThrow(ConfigError);
  });

  it("rejects positionals on `list`", () => {
    expect(() => parseDevArgs(["list", "x"])).toThrow(ConfigError);
  });
});
