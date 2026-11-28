import { describe, expect, it } from "vitest";

import { parseDevArgs, parseWorkspaceArgs } from "../src/cli.js";
import { ConfigError } from "../src/errors.js";

const SETUP_DEFAULTS = {
  kind: "setup",
  branch: undefined,
  newBranch: false,
  from: undefined,
  force: false,
  enter: false,
  dedupe: false,
  detached: false,
  full: false,
};

describe("parseWorkspaceArgs", () => {
  it.each([
    [["setup"], SETUP_DEFAULTS, false],
    [["setup", "feat/42"], { ...SETUP_DEFAULTS, branch: "feat/42" }, false],
    [
      ["setup", "feat/42", "--force", "--enter", "--verbose"],
      { ...SETUP_DEFAULTS, branch: "feat/42", force: true, enter: true },
      true,
    ],
    [
      ["setup", "-c", "feat/42", "--full", "-d", "--dedupe"],
      {
        ...SETUP_DEFAULTS,
        branch: "feat/42",
        newBranch: true,
        full: true,
        detached: true,
        dedupe: true,
      },
      false,
    ],
    [
      ["setup", "feat/456", "-c", "--from", "origin/feat/123", "--detached"],
      {
        ...SETUP_DEFAULTS,
        branch: "feat/456",
        newBranch: true,
        from: "origin/feat/123",
        detached: true,
      },
      false,
    ],
    [["setup", "--path", "../wt"], { ...SETUP_DEFAULTS, path: "../wt" }, false],
    [["remove"], { kind: "remove", selector: { dir: undefined }, force: false }, false],
    [
      ["remove", "../my-wt", "--force"],
      { kind: "remove", selector: { dir: "../my-wt" }, force: true },
      false,
    ],
    [["teardown"], { kind: "teardown", selector: { dir: undefined } }, false],
    [
      ["teardown", "review-deadbeef", "--verbose"],
      { kind: "teardown", selector: { dir: "review-deadbeef" } },
      true,
    ],
    [["list"], { kind: "list" }, false],
    [["prune"], { kind: "prune" }, false],
    [["status", "../my-wt"], { kind: "status", selector: { dir: "../my-wt" } }, false],
    [["wait"], { kind: "wait", selector: { dir: undefined } }, false],
    [
      ["__finalize", "--force", "--full", "--verbose"],
      { kind: "finalize", force: true, full: true },
      true,
    ],
    [["--help"], { kind: "help" }, false],
    [["--guide"], { kind: "guide" }, false],
  ])("accepts %j", (argv, command, verbose) => {
    expect(parseWorkspaceArgs(argv)).toEqual({ command, verbose });
  });

  it.each([["-v"], ["--version"]])("parses %s as the version command", (flag) => {
    expect(parseWorkspaceArgs([flag]).command).toEqual({ kind: "version" });
  });

  it.each([
    ["--dedupe without -c", ["setup", "feat/42", "--dedupe"]],
    ["--from without -c", ["setup", "feat/456", "--from", "origin/feat/123"]],
    ["--enter without a branch", ["setup", "--enter"]],
    ["-c without a branch", ["setup", "-c"]],
  ])("rejects %s", (_rule, argv) => {
    expect(() => parseWorkspaceArgs(argv)).toThrow(ConfigError);
  });

  it.each([
    ["no command", []],
    ["an unknown subcommand", ["frobnicate"]],
    ["the retired migration command", ["migrate-registry-0.30"]],
    ["extra positionals", ["setup", "a", "b"]],
  ])("rejects %s", (_case, argv) => {
    expect(() => parseWorkspaceArgs(argv)).toThrow(ConfigError);
  });
});

describe("parseDevArgs", () => {
  it.each([
    [[], { kind: "foreground", evict: false, restart: false }],
    [["--evict", "--restart"], { kind: "foreground", evict: true, restart: true }],
    [["up", "--restart"], { kind: "up", evict: false, restart: true }],
    [["up", "--evict"], { kind: "up", evict: true, restart: false }],
    [["restart", "--evict"], { kind: "restart", evict: true }],
    [["down"], { kind: "down", all: false }],
    [["down", "--all"], { kind: "down", all: true }],
    [["list"], { kind: "list" }],
    [["status"], { kind: "status" }],
    [["setup"], { kind: "setup", force: false, resetPorts: false, fromFinalize: false }],
    [
      ["setup", "--force", "--reset-ports", "--from-finalize", "--verbose"],
      { kind: "setup", force: true, resetPorts: true, fromFinalize: true, verbose: true },
    ],
    [["-h"], { kind: "help" }],
  ])("accepts %j", (argv, command) => {
    expect(parseDevArgs(argv)).toMatchObject(command);
  });

  it.each([
    ["an unknown subcommand", ["bogus"]],
    ["positionals", ["status", "x"]],
  ])("rejects %s", (_case, argv) => {
    expect(() => parseDevArgs(argv)).toThrow(ConfigError);
  });
});
