import { describe, expect, it } from "vitest";

import { parseDevServerArgs, parseWorkspaceArgs, validateDevServerFlags } from "../src/cli.js";
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

  it("returns help for no command and for --help", () => {
    expect(parseWorkspaceArgs([]).command).toEqual({ kind: "help" });
    expect(parseWorkspaceArgs(["--help"]).command).toEqual({ kind: "help" });
  });
});

describe("validateDevServerFlags", () => {
  it("rejects --all without --stop", () => {
    const args = parseDevServerArgs(["--all"]);
    expect(() => validateDevServerFlags(args)).toThrow(/--all requires --stop/);
  });

  it("rejects --list with --stop", () => {
    const args = parseDevServerArgs(["--list", "--stop"]);
    expect(() => validateDevServerFlags(args)).toThrow(/--list is mutually exclusive/);
  });

  it("rejects --list with --all", () => {
    const args = parseDevServerArgs(["--list", "--stop", "--all"]);
    expect(() => validateDevServerFlags(args)).toThrow(/--list is mutually exclusive/);
  });

  it("accepts --stop --all", () => {
    const args = parseDevServerArgs(["--stop", "--all"]);
    expect(() => validateDevServerFlags(args)).not.toThrow();
  });

  it("rejects --restart with --stop", () => {
    const args = parseDevServerArgs(["--restart", "--stop"]);
    expect(() => validateDevServerFlags(args)).toThrow(/--restart cannot be combined with --stop/);
  });

  it("accepts --restart alone", () => {
    const args = parseDevServerArgs(["--restart"]);
    expect(() => validateDevServerFlags(args)).not.toThrow();
  });
});
