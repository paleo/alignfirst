import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readProjectConfig, validateProjectConfig } from "../src/project-config.js";
import { makeTempDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("project config", () => {
  it("accepts the full shape and a minimal config", () => {
    const full = {
      schemaVersion: 1,
      cli: ">=0.1.0 <0.2.0",
      ticketIdPattern: "^\\d+$",
      plans: { repositoryFolder: "project", autoArchive: true },
      portRange: { first: 8100, last: 8199 },
      git: {
        defaultBranch: "main",
        branchNameTemplate: "{TICKET_ID}/{slug}",
        commit: { style: "conventionalCommit", ticketReference: "bracketedHash" },
        agentCoauthoring: false,
      },
    };
    expect(validateProjectConfig(full, "config")).toEqual(full);
    expect(validateProjectConfig({ schemaVersion: 1 }, "config")).toEqual({ schemaVersion: 1 });
    expect(validateProjectConfig({ schemaVersion: 1, plans: {} }, "config")).toEqual({
      schemaVersion: 1,
      plans: {},
    });
    expect(
      validateProjectConfig({ schemaVersion: 1, plans: { autoArchive: true } }, "config"),
    ).toEqual({ schemaVersion: 1, plans: { autoArchive: true } });
  });

  it("warns and ignores unknown properties at every settings level without exposing values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = "PRIVATE-SETTING-VALUE";
    const value = {
      schemaVersion: 1,
      extra: { nested: secret },
      ticketPattern: secret,
      project: secret,
      plans: { repositoryFolder: "work", extra: secret },
      portRange: { first: 8100, last: 8199, extra: secret },
      git: {
        extra: secret,
        commit: { style: "conventionalCommit", extra: secret },
      },
    };
    const before = JSON.stringify(value);
    expect(validateProjectConfig(value, "config")).toEqual({
      schemaVersion: 1,
      plans: { repositoryFolder: "work" },
      portRange: { first: 8100, last: 8199 },
      git: { commit: { style: "conventionalCommit" } },
    });
    const warnings = warn.mock.calls.flat().join("\n");
    expect(warn).toHaveBeenCalledTimes(7);
    for (const field of [
      "extra",
      "ticketPattern",
      "project",
      "plans.extra",
      "portRange.extra",
      "git.extra",
      "git.commit.extra",
    ])
      expect(warnings).toContain(`setting ${field}.`);
    expect(warnings).toContain("Use ticketIdPattern");
    expect(warnings).not.toContain(secret);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("ignores unknown values of any shape and escapes control characters in keys", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const extra of [null, false, 42, "PRIVATE", [], { nested: "PRIVATE" }])
      expect(validateProjectConfig({ schemaVersion: 1, extra }, "config")).toEqual({
        schemaVersion: 1,
      });
    const key = "unknown\n\u001b\u202e\u2028";
    const value = JSON.parse('{"schemaVersion":1,"__proto__":{"secret":"PRIVATE"}}');
    value[key] = "PRIVATE";
    expect(validateProjectConfig(value, "config")).toEqual({ schemaVersion: 1 });
    const warnings = warn.mock.calls.flat().join("|");
    expect(warnings).toContain("__proto__");
    expect(warnings).toContain("\\n\\u001b\\u202e\\u2028");
    for (const control of ["\n", "\u001b", "\u202e", "\u2028"])
      expect(warnings).not.toContain(control);
    expect(warnings).not.toContain("PRIVATE");
  });

  it.each([
    [null, "must be an object"],
    [[], "must be an object"],
    [{}, "schemaVersion"],
    [{ schemaVersion: 2 }, "schemaVersion"],
    [{ schemaVersion: 1, plans: [] }, "plans"],
    [{ schemaVersion: 1, plans: { autoArchive: "PRIVATE" } }, "autoArchive"],
    [{ schemaVersion: 1, plans: { repositoryFolder: false } }, "repositoryFolder"],
    [{ schemaVersion: 1, portRange: { first: 0, last: 2 } }, "first"],
    [{ schemaVersion: 1, portRange: { first: 1 } }, "last"],
    [{ schemaVersion: 1, git: null }, "git"],
    [{ schemaVersion: 1, git: { agentCoauthoring: "PRIVATE" } }, "agentCoauthoring"],
    [{ schemaVersion: 1, git: { commit: [] } }, "commit"],
    [
      {
        schemaVersion: 1,
        git: { commit: { style: "conventionalCommit", ticketReference: false } },
      },
      "ticketReference",
    ],
    [{ schemaVersion: 1, cli: "not a range" }, "supported version range"],
    [{ schemaVersion: 1, ticketIdPattern: "[" }, "regular expression"],
    [{ schemaVersion: 1, ticketIdPattern: "^ABC-\\d+$|^XYZ-\\d+$" }, "one anchored expression"],
    [{ schemaVersion: 1, portRange: { first: 2, last: 1 } }, "must not exceed"],
    [{ schemaVersion: 1, git: { commit: { style: "other" } } }, "style"],
    [{ schemaVersion: 1, git: { commit: {} } }, "style"],
  ])("rejects invalid config %#", (value, message) => {
    expect(() => validateProjectConfig(value, "config")).toThrow(message);
  });

  it("still validates recognized fields alongside unknown properties, without leaking values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const known of [
      { cli: "PRIVATE-INVALID-RANGE" },
      { ticketIdPattern: "[PRIVATE-INVALID-PATTERN" },
      { git: { agentCoauthoring: "PRIVATE-INVALID-BOOLEAN", extra: "PRIVATE" } },
    ]) {
      expect(() =>
        validateProjectConfig({ schemaVersion: 1, extra: "PRIVATE", ...known }, "config"),
      ).toThrow(/^Invalid config:/);
      try {
        validateProjectConfig({ schemaVersion: 1, ...known }, "config");
      } catch (error) {
        expect(String(error)).not.toContain("PRIVATE");
      }
    }
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join("\n")).not.toContain("PRIVATE");
  });

  it("reads unknown settings without rewriting the config file", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = makeTempDir();
    dirs.push(dir);
    const path = join(dir, ".alignfirst.json");
    const content = '{ "schemaVersion": 1, "extra": "PRIVATE" }\n';
    writeFileSync(path, content);
    expect(readProjectConfig(path).config).toEqual({ schemaVersion: 1 });
    expect(readFileSync(path, "utf-8")).toBe(content);
    writeFileSync(path, '{"extra":"PRIVATE", BROKEN}');
    expect(() => readProjectConfig(path)).toThrow("must contain valid JSON");
    expect(() => readProjectConfig(path)).not.toThrow("PRIVATE");
  });

  it("reads the deprecated plans.folder as plans.repositoryFolder", () => {
    expect(
      validateProjectConfig(
        { schemaVersion: 1, plans: { folder: "x", autoArchive: true } },
        "config",
      ),
    ).toEqual({ schemaVersion: 1, plans: { repositoryFolder: "x", autoArchive: true } });
  });

  it("rejects plans.folder alongside plans.repositoryFolder", () => {
    expect(() =>
      validateProjectConfig(
        { schemaVersion: 1, plans: { folder: "x", repositoryFolder: "x" } },
        "config",
      ),
    ).toThrow("remove plans.folder");
  });

  it.each(["^(ABC|XYZ)-\\d+$", "^[^/]+$", "^\\$\\d+$", "\\d+"])(
    "accepts ticketIdPattern %s",
    (ticketIdPattern) => {
      expect(validateProjectConfig({ schemaVersion: 1, ticketIdPattern }, "config")).toEqual({
        schemaVersion: 1,
        ticketIdPattern,
      });
    },
  );

  it("reads a file and reports invalid JSON", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const path = join(dir, ".alignfirst.json");
    writeFileSync(path, '{"schemaVersion":1}');
    expect(readProjectConfig(path)).toEqual({ config: { schemaVersion: 1 }, deprecations: [] });
    writeFileSync(path, "{");
    expect(() => readProjectConfig(path)).toThrow(`Invalid ${path}`);
  });

  it("reports plans.folder as a deprecation, only on a valid config", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const path = join(dir, ".alignfirst.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, plans: { folder: "x" } }));
    const { deprecations } = readProjectConfig(path);
    expect(deprecations).toEqual([
      expect.stringContaining(
        `${path}: plans.folder is deprecated; rename it to plans.repositoryFolder`,
      ),
    ]);
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, ticketIdPattern: "[", plans: { folder: "x" } }),
    );
    expect(() => readProjectConfig(path)).toThrow("regular expression");
  });

  it("rejects a directory in place of the config file", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    mkdirSync(join(dir, ".alignfirst.json"));
    expect(() => readProjectConfig(join(dir, ".alignfirst.json"))).toThrow("Invalid");
  });
});
