import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadWorkspaceManifest,
  readWorkspaceConfigReport,
  resolveConfigFamily,
  validateWorkspaceManifest,
} from "../src/config.js";

const dirs: string[] = [];
const spawnServer = {
  kind: "spawn",
  name: "app",
  exec: { run: ["python", "app.py"] },
  ready: { log: "ready" },
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace manifest", () => {
  it("accepts the data contract without running producers or exposing environments", () => {
    const dir = temp();
    const sentinel = join(dir, "executed");
    const command = { run: `touch '${sentinel}'`, cwd: "packages/api", env: { SECRET: "PRIVATE" } };
    const manifest = {
      schemaVersion: 1,
      $schema:
        "https://cdn.jsdelivr.net/npm/@alignfirst/workspace/schemas/workspace-v1.schema.json",
      workspace: {
        sharedDirs: ["data"],
        preSetup: [{ ...command, name: "prepare" }],
        finalize: [{ ...command, name: "install" }],
        purge: [{ ...command, name: "purge", continueOnError: true }],
        summary: { command },
        gitignoredFiles: [
          {
            path: "api/.env",
            source: { kind: "mainWorktree", fallback: "api/.env.example" },
            patch: { env: { "custom-key": "PRIVATE" } },
          },
        ],
      },
      devServer: {
        ports: {
          first: 8100,
          last: 8199,
          exclude: [8101],
          declare: [
            "api",
            { name: "fo-api", range: { first: 8150, last: 8199 }, mainWorktree: 8150 },
          ],
        },
        runFiles: [
          {
            path: "api/config.json",
            source: { kind: "content", content: { command } },
            patch: { command },
            optional: true,
          },
        ],
        runFilesInputs: { command },
        setup: [{ ...command, name: "dev" }],
        summary: "Application ready.",
        maxConcurrentDevServers: 2,
        servers: [
          { ...spawnServer, port: "fo-api", exec: command },
          { kind: "command", name: "db", start: command, stop: command },
        ],
      },
    };
    writeFileSync(join(dir, "alignfirst-workspace.json"), JSON.stringify(manifest));
    expect(loadWorkspaceManifest(dir)).toEqual(manifest);
    expect(readWorkspaceConfigReport(dir)).toEqual({
      location: { path: join(dir, "alignfirst-workspace.json"), in: "project", exists: true },
      schemaVersion: 1,
      portRange: { first: 8100, last: 8199 },
      hasDevServer: true,
    });
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(join(dir, ".local-wt"))).toBe(false);
  });

  it.each(["json", "jsonc"])(
    "preserves prototype-named dynamic keys in %s and rejects unknown __proto__ settings",
    (extension) => {
      const dir = temp();
      const path = join(dir, `alignfirst-workspace.${extension}`);
      const text =
        '{"schemaVersion":1,"workspace":{"preSetup":[{"name":"env","run":["true"],"env":{"__proto__":"PRIVATE","constructor":"literal"}}],"gitignoredFiles":[{"path":".env","source":{"kind":"content","content":""},"patch":{"env":{"__proto__":"literal"}}}]},"devServer":{"ports":{"first":8100,"last":8199,"declare":[{"name":"__proto__","mainWorktree":8100},"constructor"]},"servers":[{"kind":"spawn","name":"app","exec":{"run":["true"]},"ready":{"log":""},"port":"__proto__"}]}}';
      writeFileSync(path, text);
      const manifest = loadWorkspaceManifest(dir);
      expect(Object.hasOwn(manifest?.workspace?.preSetup?.[0].env ?? {}, "__proto__")).toBe(true);
      expect(Object.entries(manifest?.workspace?.preSetup?.[0].env ?? {})).toContainEqual([
        "__proto__",
        "PRIVATE",
      ]);
      expect(manifest?.workspace?.gitignoredFiles?.[0].patch).toEqual({
        env: { ["__proto__"]: "literal" },
      });
      expect(manifest?.devServer?.ports?.declare).toEqual([
        { name: "__proto__", mainWorktree: 8100 },
        "constructor",
      ]);
      expect(readFileSync(path, "utf8")).toBe(text);
      writeFileSync(path, '{"schemaVersion":1,"__proto__":{"secret":"PRIVATE"}}');
      expect(() => loadWorkspaceManifest(dir)).toThrow("__proto__");
      expect(() => loadWorkspaceManifest(dir)).not.toThrow("PRIVATE");
    },
  );

  it.each([
    [{ schemaVersion: 2 }, "schemaVersion"],
    [{ schemaVersion: 1, workspace: { finalise: [] } }, "finalise"],
    [
      {
        schemaVersion: 1,
        workspace: { preSetup: [{ name: "bad", run: [], env: { SECRET: "PRIVATE" } }] },
      },
      "run",
    ],
    [
      {
        schemaVersion: 1,
        workspace: { finalize: [{ name: "bad", run: "true", continueOnError: true }] },
      },
      "continueOnError",
    ],
    [
      {
        schemaVersion: 1,
        devServer: { servers: [{ kind: "command", name: "db", start: { run: "true" } }] },
      },
      "spawn",
    ],
    [
      { schemaVersion: 1, devServer: { servers: [spawnServer], maxConcurrentDevServers: 0 } },
      "maxConcurrentDevServers",
    ],
    [{ schemaVersion: 1, devServer: { servers: [{ ...spawnServer, name: "../escape" }] } }, "name"],
    [
      {
        schemaVersion: 1,
        devServer: { servers: [{ ...spawnServer, exec: { run: "true", enb: {} } }] },
      },
      "enb",
    ],
    [{ schemaVersion: 1, devServer: { servers: [spawnServer, spawnServer] } }, "duplicate server"],
    [
      {
        schemaVersion: 1,
        devServer: { servers: [{ ...spawnServer, ready: { log: "[PRIVATE" } }] },
      },
      "ready.log",
    ],
    [
      {
        schemaVersion: 1,
        devServer: { servers: [{ ...spawnServer, error: { log: "[PRIVATE" } }] },
      },
      "error.log",
    ],
    [
      { schemaVersion: 1, devServer: { servers: [{ ...spawnServer, port: "missing" }] } },
      "undeclared port",
    ],
    [
      {
        schemaVersion: 1,
        devServer: {
          servers: [spawnServer],
          ports: { first: 8100, last: 8199, declare: [{ name: "api", mainWorktree: 8200 }] },
        },
      },
      "mainWorktree",
    ],
    [
      {
        schemaVersion: 1,
        workspace: { gitignoredFiles: [{ path: "config/.env", source: { kind: "mainWorktree" } }] },
        devServer: {
          servers: [spawnServer],
          runFiles: [{ path: "config/./.env", source: { kind: "committed", path: "template" } }],
        },
      },
      "also occurs",
    ],
  ])("rejects invalid manifest %# without data values", (value, field) => {
    expect(() => validateWorkspaceManifest(value, "manifest")).toThrow(field);
    expect(() => validateWorkspaceManifest(value, "manifest")).not.toThrow("PRIVATE");
  });

  it("distinguishes absence, broken links, ambiguity and JSON syntax", () => {
    const dir = temp();
    expect(loadWorkspaceManifest(dir)).toBeUndefined();
    expect(readWorkspaceConfigReport(dir)).toMatchObject({
      schemaVersion: null,
      portRange: null,
      hasDevServer: false,
      location: { exists: false },
    });
    const json = join(dir, "alignfirst-workspace.json");
    const jsonc = join(dir, "alignfirst-workspace.jsonc");
    symlinkSync(join(dir, "missing"), jsonc);
    expect(() => loadWorkspaceManifest(dir)).toThrow("cannot read");
    writeFileSync(json, '{"schemaVersion":1}');
    expect(() => resolveConfigFamily(dir, "alignfirst-workspace")).toThrow("Ambiguous");
    rmSync(jsonc);
    const text = '{/* comment */ "schemaVersion":1,}';
    writeFileSync(json, text);
    expect(() => loadWorkspaceManifest(dir)).toThrow("valid JSON");
    rmSync(json);
    writeFileSync(jsonc, text);
    expect(loadWorkspaceManifest(dir)).toEqual({ schemaVersion: 1 });
    writeFileSync(jsonc, '{"schemaVersion":1 BROKEN}');
    expect(() => loadWorkspaceManifest(dir)).toThrow("valid JSONC");
  });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "workspace-config-"));
  dirs.push(dir);
  return dir;
}
