import { describe, expect, it } from "vitest";

import {
  parseDevServerArgs,
  parseSetupArgs,
  validateDevServerFlags,
  validateSetupFlags,
} from "../src/cli.js";
import { ConfigError } from "../src/errors.js";

describe("validateSetupFlags", () => {
  it("rejects --use + --create", () => {
    const args = parseSetupArgs(["--use", "a", "--create", "b"]);
    expect(() => validateSetupFlags(args)).toThrow(ConfigError);
  });

  it("rejects --use + --remove", () => {
    const args = parseSetupArgs(["--use", "a", "--remove", "b"]);
    expect(() => validateSetupFlags(args)).toThrow(ConfigError);
  });

  it("rejects --owner without a setup mode", () => {
    const args = parseSetupArgs(["--owner", "alice"]);
    expect(() => validateSetupFlags(args)).toThrow(/--owner is only valid/);
  });

  it("rejects --no-remote-check without remove", () => {
    const args = parseSetupArgs(["--use", "a", "--no-remote-check"]);
    expect(() => validateSetupFlags(args)).toThrow(/--no-remote-check/);
  });

  it("rejects --slot without a setup mode", () => {
    const args = parseSetupArgs(["--slot", "8110"]);
    expect(() => validateSetupFlags(args)).toThrow(/--slot and --force/);
  });

  it("rejects --remove + --remove-here", () => {
    const args = parseSetupArgs(["--remove", "a", "--remove-here"]);
    expect(() => validateSetupFlags(args)).toThrow(/mutually exclusive/);
  });

  it("accepts a valid setup invocation", () => {
    const args = parseSetupArgs(["--use", "a", "--owner", "alice", "--slot", "8110", "--force"]);
    expect(() => validateSetupFlags(args)).not.toThrow();
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
});
