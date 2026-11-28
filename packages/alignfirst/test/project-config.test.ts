import { validateConfigSchema } from "@alignfirst/workspace/config";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readProjectConfig, validateProjectConfig } from "../src/project-config.js";
import { makeTempDir } from "./helpers.js";

const projectSchema: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("../schemas/alignfirst-v1.schema.json", import.meta.url), "utf8"),
);
const SPAWN_SERVER = { kind: "spawn", name: "app", exec: { run: "true" }, ready: { log: "ready" } };
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

  it("keeps a deprecated guide name and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = { schemaVersion: 1, assistantInstructionsFile: "guides/team.md" };
    expect(validateProjectConfig(input, "config")).toEqual(input);
    expect(warn).toHaveBeenCalledOnce();
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
    [{ schemaVersion: 2 }, "schemaVersion"],
    [{ schemaVersion: 1, $schema: "not a URI" }, "$schema"],
    [{ schemaVersion: 1, plans: { autoArchive: "PRIVATE" } }, "autoArchive"],
    [{ schemaVersion: 1, conventions: { git: { commit: { style: "other" } } } }, "style"],
    [{ schemaVersion: 1, conventions: { git: { commit: {} } } }, "style"],
    [{ schemaVersion: 1, conventions: { ticketIdPattern: "[PRIVATE" } }, "ticketIdPattern"],
    [
      { schemaVersion: 1, conventions: { ticketIdPattern: "^ABC-\\d+$|^XYZ-\\d+$" } },
      "ticketIdPattern",
    ],
  ])("rejects malformed retained fields %# without values", (value, message) => {
    expect(() => validateProjectConfig(value, "config")).toThrow(message);
    expect(() => validateProjectConfig(value, "config")).not.toThrow("PRIVATE");
  });

  it.each([
    ["cli", { cli: ">=1" }],
    ["portRange", { portRange: { first: 8100, last: 8199 } }],
    ["ticketPattern", { ticketPattern: "^\\d+$" }],
    ["plans/folder", { plans: { folder: "work-files" } }],
    [
      "conventions/git/commit/typo",
      { conventions: { git: { commit: { style: "conventionalCommit", typo: true } } } },
    ],
  ])("rejects the retired or unknown setting %s", (pointer, settings) => {
    expect(() => validateProjectConfig({ schemaVersion: 1, ...settings }, "config")).toThrow(
      `/${pointer}`,
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

  it.each([0, { env: "DEV_LIMIT", default: 0 }])(
    "retains the authored concurrency limit %j",
    (maxConcurrentDevServers) => {
      const devServer = { servers: [SPAWN_SERVER], maxConcurrentDevServers };
      expect(
        validateProjectConfig({ schemaVersion: 1, devServer }, "config").devServer
          ?.maxConcurrentDevServers,
      ).toEqual(maxConcurrentDevServers);
    },
  );

  it.each([
    ["/workspace/finalise", { workspace: { finalise: [] } }],
    [
      "/workspace/finalize/0/continueOnError",
      { workspace: { finalize: [{ name: "bad", run: "true", continueOnError: true }] } },
    ],
    [
      "/devServer/servers/0/kind",
      { devServer: { servers: [{ kind: "command", name: "db", start: { run: "true" } }] } },
    ],
    [
      "/devServer/servers/0/exec/enb",
      { devServer: { servers: [{ ...SPAWN_SERVER, exec: { run: "true", enb: {} } }] } },
    ],
    [
      "/devServer/maxConcurrentDevServers/env",
      {
        devServer: {
          servers: [SPAWN_SERVER],
          maxConcurrentDevServers: { env: "BAD-NAME", default: 1 },
        },
      },
    ],
    [
      "/devServer/maxConcurrentDevServers/default",
      { devServer: { servers: [SPAWN_SERVER], maxConcurrentDevServers: { env: "DEV_LIMIT" } } },
    ],
    [
      "/devServer/maxConcurrentDevServers/extra",
      {
        devServer: {
          servers: [SPAWN_SERVER],
          maxConcurrentDevServers: { env: "DEV_LIMIT", default: 1, extra: true },
        },
      },
    ],
    ["/devServer/servers/0/error", { devServer: { servers: [{ ...SPAWN_SERVER, error: {} }] } }],
    [
      "/devServer/servers/0/error/preset",
      { devServer: { servers: [{ ...SPAWN_SERVER, error: { preset: "python" } }] } },
    ],
    ["/__proto__", JSON.parse('{"__proto__":{"secret":"literal"}}')],
  ])("rejects the malformed recipe field %s", (pointer, settings) => {
    expect(() => validateProjectConfig({ schemaVersion: 1, ...settings }, "config")).toThrow(
      pointer,
    );
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
});

function configPath(extension: string): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return join(dir, `alignfirst.${extension}`);
}
