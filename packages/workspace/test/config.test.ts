import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  configFamilyExists,
  readConfigFile,
  resolveConfigFamily,
  validateWorkspaceSettings,
  type WorkspaceManifest,
} from "../src/config.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("distinguishes absence, broken links, ambiguity and strict JSON/JSONC without rewriting", () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-config-"));
  dirs.push(dir);
  const json = join(dir, "settings.json");
  const jsonc = join(dir, "settings.jsonc");
  expect(resolveConfigFamily(dir, "settings")).toEqual({ path: json, exists: false });
  symlinkSync(join(dir, "missing"), jsonc);
  expect(configFamilyExists(dir, "settings")).toBe(true);
  expect(() => readConfigFile(resolveConfigFamily(dir, "settings").path)).toThrow("cannot read");
  writeFileSync(json, "{}");
  expect(() => resolveConfigFamily(dir, "settings")).toThrow("Ambiguous");
  rmSync(jsonc);
  const text = '{/* comment */ "__proto__":"literal",}';
  writeFileSync(json, text);
  expect(() => readConfigFile(json)).toThrow("valid JSON");
  rmSync(json);
  writeFileSync(jsonc, text);
  expect(Object.entries(readConfigFile(jsonc) ?? {})).toContainEqual(["__proto__", "literal"]);
  expect(readFileSync(jsonc, "utf8")).toBe(text);
  writeFileSync(jsonc, '{"key": BROKEN}');
  expect(() => readConfigFile(jsonc)).toThrow("valid JSONC");
});

it("checks source-independent recipe semantics after structural validation", () => {
  const spawn = {
    kind: "spawn" as const,
    name: "api",
    exec: { run: "true" },
    ready: { log: "ready" },
  };
  const cases: [WorkspaceManifest, string][] = [
    [{ devServer: { servers: [spawn, spawn] } }, "duplicate server"],
    [{ devServer: { servers: [{ ...spawn, port: "unknown" }] } }, "undeclared port"],
    [{ devServer: { servers: [{ ...spawn, ready: { log: "[" } }] } }, "ready.log"],
    [{ devServer: { servers: [{ ...spawn, error: { log: "[" } }] } }, "error.log"],
    [
      {
        devServer: {
          servers: [spawn],
          ports: { first: 8100, last: 8199, declare: [{ name: "api", mainWorktree: 8200 }] },
        },
      },
      "mainWorktree",
    ],
    [
      {
        workspace: { gitignoredFiles: [{ path: "config/.env", source: { kind: "mainWorktree" } }] },
        devServer: {
          servers: [spawn],
          runFiles: [{ path: "config/./.env", source: { kind: "committed", path: "template" } }],
        },
      },
      "also occurs",
    ],
  ];
  for (const [settings, field] of cases)
    expect(() => validateWorkspaceSettings(settings, "recipe")).toThrow(field);
});
