import { validateConfigSchema } from "@alignfirst/workspace/config";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readProjectConfig, validateProjectConfig } from "../src/project-config.js";
import { makeTempDir } from "./helpers.js";

const projectSchema: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("../schemas/alignfirst-v1.schema.json", import.meta.url), "utf8"),
);
const dirs: string[] = [];
// Avoid colliding with the runtime's separately loaded schema in the shared Ajv instance.
delete projectSchema.$id;

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("project config", () => {
  it.each([
    { assistantInstructionsFile: undefined, expected: "guides/legacy.md" },
    { assistantInstructionsFile: "guides/canonical.md", expected: "guides/canonical.md" },
  ])("normalizes the legacy instructions reference and warns %#", (settings) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = {
      schemaVersion: 1,
      assistantInstructionsFile: settings.assistantInstructionsFile,
      developerInstructions: "guides/legacy.md",
    };
    expect(() => validateConfigSchema(input, projectSchema, "config")).not.toThrow();
    const config = validateProjectConfig(input, "config");
    expect(config).toEqual({
      schemaVersion: 1,
      assistantInstructionsFile: settings.expected,
    });
    expect(warn).toHaveBeenCalled();
  });

  it.each([null, false, "", "   "])(
    "rejects an invalid canonical instructions reference without using the legacy value %#",
    (assistantInstructionsFile) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const input = {
        schemaVersion: 1,
        assistantInstructionsFile,
        developerInstructions: "valid.md",
      };
      expect(() => validateConfigSchema(input, projectSchema, "config")).toThrow(
        "assistantInstructionsFile",
      );
      expect(() => validateProjectConfig(input, "config")).toThrow("assistantInstructionsFile");
      expect(warn).toHaveBeenCalled();
    },
  );

  it.each([null, false, "", "   "])(
    "validates the deprecated instructions reference only when the canonical one is absent %#",
    (developerInstructions) => {
      const legacyOnly = { schemaVersion: 1, developerInstructions };
      expect(() => validateConfigSchema(legacyOnly, projectSchema, "config")).toThrow(
        "developerInstructions",
      );
      expect(() =>
        validateConfigSchema(
          { ...legacyOnly, assistantInstructionsFile: "valid.md" },
          projectSchema,
          "config",
        ),
      ).not.toThrow();
    },
  );

  it("accepts the retained fields and minimal settings", () => {
    const full = {
      schemaVersion: 1,
      $schema: "https://cdn.jsdelivr.net/npm/alignfirst/schemas/alignfirst-v1.schema.json",
      conventions: {
        ticketIdPattern: "^\\d+$",
        git: {
          defaultBranch: "main",
          branchNameTemplate: "{TICKET_ID}/{slug}",
          commit: { style: "conventionalCommit", ticketReference: "bracketedHash" },
          agentCoauthoring: false,
        },
      },
      plans: { repositoryFolder: "project", autoArchive: true },
    };
    expect(validateProjectConfig(full, "config")).toEqual(full);
    expect(
      validateProjectConfig({ schemaVersion: 1, plans: {}, conventions: { git: {} } }, "config"),
    ).toEqual({
      schemaVersion: 1,
      plans: {},
      conventions: { git: {} },
    });
  });

  it.each([
    [null, undefined],
    [[], undefined],
    [{}, "schemaVersion"],
    [{ schemaVersion: 2 }, "schemaVersion"],
    [{ schemaVersion: 1, $schema: "not a URI" }, "$schema"],
    [{ schemaVersion: 1, plans: [] }, "plans"],
    [{ schemaVersion: 1, plans: { autoArchive: "PRIVATE" } }, "autoArchive"],
    [{ schemaVersion: 1, plans: { repositoryFolder: false } }, "repositoryFolder"],
    [{ schemaVersion: 1, conventions: { git: null } }, "git"],
    [
      { schemaVersion: 1, conventions: { git: { agentCoauthoring: "PRIVATE" } } },
      "agentCoauthoring",
    ],
    [{ schemaVersion: 1, conventions: { git: { commit: [] } } }, "commit"],
    [
      {
        schemaVersion: 1,
        conventions: { git: { commit: { style: "conventionalCommit", ticketReference: false } } },
      },
      "ticketReference",
    ],
    [{ schemaVersion: 1, conventions: { git: { commit: { style: "other" } } } }, "style"],
    [{ schemaVersion: 1, conventions: { git: { commit: {} } } }, "style"],
    [{ schemaVersion: 1, conventions: { ticketIdPattern: "[PRIVATE" } }, undefined],
    [{ schemaVersion: 1, conventions: { ticketIdPattern: "^ABC-\\d+$|^XYZ-\\d+$" } }, undefined],
  ])("rejects malformed retained fields %# without values", (value, message) => {
    expect(() => validateProjectConfig(value, "config")).toThrow(message);
    expect(() => validateProjectConfig(value, "config")).not.toThrow("PRIVATE");
  });

  it.each([
    { cli: ">=1" },
    { ticketIdPattern: "^\\d+$" },
    { git: { defaultBranch: "main" } },
    { portRange: { first: 8100, last: 8199 } },
    { ticketPattern: "PRIVATE" },
    { extra: "PRIVATE" },
    { plans: { folder: "PRIVATE" } },
    { plans: { typo: "PRIVATE" } },
    { conventions: { git: { typo: "PRIVATE" } } },
    { conventions: { git: { commit: { style: "conventionalCommit", typo: "PRIVATE" } } } },
  ])("rejects retired and unknown settings without exposing values %#", (settings) => {
    expect(() => validateProjectConfig({ schemaVersion: 1, ...settings }, "config")).toThrow();
    expect(() => validateProjectConfig({ schemaVersion: 1, ...settings }, "config")).not.toThrow(
      "PRIVATE",
    );
  });

  it.each(["^(ABC|XYZ)-\\d+$", "^[^/]+$", "^\\$\\d+$", "\\d+"])(
    "accepts pattern %s",
    (ticketIdPattern) => {
      expect(
        validateProjectConfig({ schemaVersion: 1, conventions: { ticketIdPattern } }, "config")
          .conventions?.ticketIdPattern,
      ).toBe(ticketIdPattern);
    },
  );

  it.each([
    { workspace: { finalise: [] } },
    { workspace: { preSetup: [{ name: "bad", run: [], env: { SECRET: "PRIVATE" } }] } },
    { workspace: { finalize: [{ name: "bad", run: "true", continueOnError: true }] } },
    { devServer: { servers: [{ kind: "command", name: "db", start: { run: "true" } }] } },
    {
      devServer: {
        servers: [
          { kind: "spawn", name: "../escape", exec: { run: "true" }, ready: { log: "ready" } },
        ],
      },
    },
    { assistantInstructionsFile: "   " },
    {
      devServer: {
        servers: [
          { kind: "spawn", name: "app", exec: { run: "true", enb: {} }, ready: { log: "ready" } },
        ],
      },
    },
    {
      devServer: {
        servers: [{ kind: "spawn", name: "app", exec: { run: "true" }, ready: { log: "ready" } }],
        maxConcurrentDevServers: -1,
      },
    },
  ])("rejects malformed merged recipes without exposing values %#", (settings) => {
    expect(() => validateProjectConfig({ schemaVersion: 1, ...settings }, "config")).toThrow();
    expect(() => validateProjectConfig({ schemaVersion: 1, ...settings }, "config")).not.toThrow(
      "PRIVATE",
    );
  });

  it.each([
    0,
    Number.MAX_SAFE_INTEGER,
    { env: "DEV_LIMIT", default: 0 },
    { env: "DEV_LIMIT", default: Number.MAX_SAFE_INTEGER },
  ])("retains authored concurrency limits %#", (maxConcurrentDevServers) => {
    const devServer = {
      servers: [
        {
          kind: "spawn",
          name: "app",
          exec: { run: "true" },
          ready: { log: "ready" },
          error: { preset: "node" },
        },
      ],
      maxConcurrentDevServers,
    };
    expect(
      validateProjectConfig({ schemaVersion: 1, devServer }, "config").devServer
        ?.maxConcurrentDevServers,
    ).toEqual(maxConcurrentDevServers);
  });

  it.each([
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    { env: "", default: 1 },
    { env: "BAD-NAME", default: 1 },
    { env: "LIMIT\n", default: 1 },
    { env: "DEV_LIMIT" },
    { env: "DEV_LIMIT", default: -1 },
    { env: "DEV_LIMIT", default: 0.5 },
    { env: "DEV_LIMIT", default: Number.MAX_SAFE_INTEGER + 1 },
    { env: "DEV_LIMIT", default: 1, extra: true },
  ])("rejects malformed authored concurrency limits %#", (maxConcurrentDevServers) => {
    expect(() =>
      validateProjectConfig(
        {
          schemaVersion: 1,
          devServer: {
            servers: [
              { kind: "spawn", name: "app", exec: { run: "true" }, ready: { log: "ready" } },
            ],
            maxConcurrentDevServers,
          },
        },
        "config",
      ),
    ).toThrow("maxConcurrentDevServers");
  });

  it.each([{}, { preset: "python" }, { preset: "node", log: "[" }, { log: "[" }])(
    "rejects invalid error descriptors %#",
    (error) => {
      expect(() =>
        validateProjectConfig(
          {
            schemaVersion: 1,
            devServer: {
              servers: [
                {
                  kind: "spawn",
                  name: "app",
                  exec: { run: "true" },
                  ready: { log: "ready" },
                  error,
                },
              ],
            },
          },
          "config",
        ),
      ).toThrow("error");
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

  it("preserves literal prototype-named dictionaries in merged recipes without rewriting", () => {
    const path = configPath("jsonc");
    const text =
      '{/* authored */ "schemaVersion":1,"workspace":{"preSetup":[{"name":"env","run":["true"],"env":{"__proto__":"PRIVATE","constructor":"literal"}}],"gitignoredFiles":[{"path":".env","source":{"kind":"content","content":""},"patch":{"env":{"__proto__":"literal"}}}]},"devServer":{"ports":{"first":8100,"last":8199,"declare":[{"name":"__proto__","mainWorktree":8100},"constructor"]},"servers":[{"kind":"spawn","name":"app","exec":{"run":["true"]},"ready":{"log":""},"port":"__proto__"}]},}';
    writeFileSync(path, text);
    const { config } = readProjectConfig(path);
    expect(Object.entries(config.workspace?.preSetup?.[0].env ?? {})).toContainEqual([
      "__proto__",
      "PRIVATE",
    ]);
    expect(config.workspace?.gitignoredFiles?.[0].patch).toEqual({
      env: { ["__proto__"]: "literal" },
    });
    expect(config.devServer?.ports?.declare).toEqual([
      { name: "__proto__", mainWorktree: 8100 },
      "constructor",
    ]);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("uses strict JSON and permits comments/trailing commas only in JSONC", () => {
    const json = configPath("json");
    const jsonc = configPath("jsonc");
    for (const text of ['{/* comment */ "schemaVersion":1}', '{"schemaVersion":1,}']) {
      writeFileSync(json, text);
      writeFileSync(jsonc, text);
      expect(() => readProjectConfig(json)).toThrow();
      expect(readProjectConfig(jsonc)).toEqual({ config: { schemaVersion: 1 } });
      expect(readFileSync(jsonc, "utf8")).toBe(text);
    }
    writeFileSync(jsonc, '{"schemaVersion":1 BROKEN}');
    expect(() => readProjectConfig(jsonc)).toThrow();
  });

  it("rejects unreadable and non-file destinations", () => {
    const path = configPath("json");
    expect(() => readProjectConfig(path)).toThrow();
    mkdirSync(path);
    expect(() => readProjectConfig(path)).toThrow();
  });
});

function configPath(extension: string): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return join(dir, `alignfirst.${extension}`);
}
