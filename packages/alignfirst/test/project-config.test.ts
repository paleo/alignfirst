import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readProjectConfig, validateProjectConfig } from "../src/project-config.js";
import { makeTempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("project config", () => {
  it("accepts the retained fields and minimal settings", () => {
    const full = {
      schemaVersion: 1,
      $schema: "https://cdn.jsdelivr.net/npm/alignfirst/schemas/alignfirst-v1.schema.json",
      ticketIdPattern: "^\\d+$",
      plans: { repositoryFolder: "project", autoArchive: true },
      git: {
        defaultBranch: "main",
        branchNameTemplate: "{TICKET_ID}/{slug}",
        commit: { style: "conventionalCommit", ticketReference: "bracketedHash" },
        agentCoauthoring: false,
      },
    };
    expect(validateProjectConfig(full, "config")).toEqual(full);
    expect(validateProjectConfig({ schemaVersion: 1, plans: {}, git: {} }, "config")).toEqual({
      schemaVersion: 1,
      plans: {},
      git: {},
    });
  });

  it.each([
    [null, "object"],
    [[], "object"],
    [{}, "schemaVersion"],
    [{ schemaVersion: 2 }, "schemaVersion"],
    [{ schemaVersion: 1, $schema: "not a URI" }, "$schema"],
    [{ schemaVersion: 1, plans: [] }, "plans"],
    [{ schemaVersion: 1, plans: { autoArchive: "PRIVATE" } }, "autoArchive"],
    [{ schemaVersion: 1, plans: { repositoryFolder: false } }, "repositoryFolder"],
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
    [{ schemaVersion: 1, git: { commit: { style: "other" } } }, "style"],
    [{ schemaVersion: 1, git: { commit: {} } }, "style"],
    [{ schemaVersion: 1, ticketIdPattern: "[PRIVATE" }, "regular expression"],
    [{ schemaVersion: 1, ticketIdPattern: "^ABC-\\d+$|^XYZ-\\d+$" }, "one anchored expression"],
  ])("rejects malformed retained fields %# without values", (value, message) => {
    expect(() => validateProjectConfig(value, "config")).toThrow(message);
    expect(() => validateProjectConfig(value, "config")).not.toThrow("PRIVATE");
  });

  it.each([
    { cli: ">=1" },
    { portRange: { first: 8100, last: 8199 } },
    { ticketPattern: "PRIVATE" },
    { extra: "PRIVATE" },
    { plans: { folder: "PRIVATE" } },
    { plans: { typo: "PRIVATE" } },
    { git: { typo: "PRIVATE" } },
    { git: { commit: { style: "conventionalCommit", typo: "PRIVATE" } } },
  ])("rejects retired and unknown settings with update guidance %#", (settings) => {
    expect(() => validateProjectConfig({ schemaVersion: 1, ...settings }, "config")).toThrow(
      "update alignfirst",
    );
    expect(() => validateProjectConfig({ schemaVersion: 1, ...settings }, "config")).not.toThrow(
      "PRIVATE",
    );
  });

  it.each(["^(ABC|XYZ)-\\d+$", "^[^/]+$", "^\\$\\d+$", "\\d+"])(
    "accepts pattern %s",
    (ticketIdPattern) => {
      expect(
        validateProjectConfig({ schemaVersion: 1, ticketIdPattern }, "config").ticketIdPattern,
      ).toBe(ticketIdPattern);
    },
  );

  it.each(["json", "jsonc"])("rejects literal __proto__ in %s without rewriting", (extension) => {
    const path = configPath(extension);
    const text = '{"schemaVersion":1,"__proto__":{"secret":"PRIVATE"}}';
    writeFileSync(path, text);
    expect(() => readProjectConfig(path)).toThrow("__proto__");
    expect(() => readProjectConfig(path)).not.toThrow("PRIVATE");
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("uses strict JSON and permits comments/trailing commas only in JSONC", () => {
    const json = configPath("json");
    const jsonc = configPath("jsonc");
    for (const text of ['{/* comment */ "schemaVersion":1}', '{"schemaVersion":1,}']) {
      writeFileSync(json, text);
      writeFileSync(jsonc, text);
      expect(() => readProjectConfig(json)).toThrow("valid JSON");
      expect(readProjectConfig(jsonc)).toEqual({ config: { schemaVersion: 1 } });
      expect(readFileSync(jsonc, "utf8")).toBe(text);
    }
    writeFileSync(jsonc, '{"schemaVersion":1 BROKEN}');
    expect(() => readProjectConfig(jsonc)).toThrow("valid JSONC");
  });

  it("rejects unreadable and non-file destinations", () => {
    const path = configPath("json");
    expect(() => readProjectConfig(path)).toThrow("cannot read");
    mkdirSync(path);
    expect(() => readProjectConfig(path)).toThrow("cannot read");
  });
});

function configPath(extension: string): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return join(dir, `alignfirst.${extension}`);
}
