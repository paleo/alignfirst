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
      "--owner",
      "alice",
      "--slot",
      "8110",
      "--force",
      "--wait",
      "-v",
    ]);
    expect(command).toEqual({
      kind: "setup",
      branch: "feat/42",
      newBranch: false,
      owner: "alice",
      slot: "8110",
      force: true,
      wait: true,
    });
    expect(verbose).toBe(true);
  });

  it("rejects `-c` without a branch", () => {
    expect(() => parseWorkspaceArgs(["setup", "-c"])).toThrow(ConfigError);
  });

  it("rejects an unknown flag on setup", () => {
    expect(() => parseWorkspaceArgs(["setup", "--nope"])).toThrow(ConfigError);
  });

  it("rejects extra positionals on setup", () => {
    expect(() => parseWorkspaceArgs(["setup", "a", "b"])).toThrow(ConfigError);
  });

  it("parses `remove` without a branch", () => {
    const { command } = parseWorkspaceArgs(["remove"]);
    expect(command).toEqual({ kind: "remove", branch: undefined, noRemoteCheck: false });
  });

  it("parses `remove <branch> --no-remote-check`", () => {
    const { command } = parseWorkspaceArgs(["remove", "feat/42", "--no-remote-check"]);
    expect(command).toEqual({ kind: "remove", branch: "feat/42", noRemoteCheck: true });
  });

  it("parses `set-owner <name>`", () => {
    const { command } = parseWorkspaceArgs(["set-owner", "alice"]);
    expect(command).toEqual({ kind: "set-owner", name: "alice" });
  });

  it("rejects `set-owner` without a name", () => {
    expect(() => parseWorkspaceArgs(["set-owner"])).toThrow(ConfigError);
  });

  it("parses `list`", () => {
    const { command } = parseWorkspaceArgs(["list"]);
    expect(command).toEqual({ kind: "list" });
  });

  it("parses `info` and `info --slot`", () => {
    expect(parseWorkspaceArgs(["info"]).command).toEqual({ kind: "info", slot: undefined });
    expect(parseWorkspaceArgs(["info", "--slot", "8110"]).command).toEqual({
      kind: "info",
      slot: "8110",
    });
  });

  it("parses `wait`", () => {
    expect(parseWorkspaceArgs(["wait"]).command).toEqual({ kind: "wait", slot: undefined });
  });

  it("rejects an unknown subcommand", () => {
    expect(() => parseWorkspaceArgs(["frobnicate"])).toThrow(ConfigError);
  });

  it("throws for no command, returns help for --help", () => {
    expect(() => parseWorkspaceArgs([])).toThrow(ConfigError);
    expect(parseWorkspaceArgs(["--help"]).command).toEqual({ kind: "help" });
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

  it("parses `down` and `down --all`", () => {
    expect(parseDevArgs(["down"])).toEqual({ kind: "down", all: false });
    expect(parseDevArgs(["down", "--all"])).toEqual({ kind: "down", all: true });
  });

  it("parses `list`", () => {
    expect(parseDevArgs(["list"])).toEqual({ kind: "list" });
  });

  it("parses `--help` / `-h`", () => {
    expect(parseDevArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseDevArgs(["-h"])).toEqual({ kind: "help" });
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
