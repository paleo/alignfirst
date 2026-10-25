import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readScenarioSurfaces } from "../src/loop.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("readScenarioSurfaces", () => {
  it("maps a scenario without the export to undefined", () => {
    const dir = makeScenarios({
      A01: 'export default async function run(): Promise<void> {}\nconst surfaces = ["x"];\n',
    });
    expect(readScenarioSurfaces(dir, ["A01"])).toEqual(new Map([["A01", undefined]]));
  });

  it("reads a literal array, with or without the type annotation", () => {
    const dir = makeScenarios({
      A26: 'export const surfaces: readonly string[] = ["webchat"];\n',
      A28: "export const surfaces = [\n  'webchat',\n  \"slack-mock\",\n];\n",
    });
    expect(readScenarioSurfaces(dir, ["A26", "A28"])).toEqual(
      new Map([
        ["A26", ["webchat"]],
        ["A28", ["webchat", "slack-mock"]],
      ]),
    );
  });

  it("rejects an export in another form, naming the file", () => {
    const dir = makeScenarios({
      A27: 'const all = ["webchat"];\nexport const surfaces: readonly string[] = all;\n',
    });
    expect(() => readScenarioSurfaces(dir, ["A27"])).toThrow(
      `${join(dir, "A27.ts")}: declare surfaces as an array of string literals`,
    );
  });

  it("rejects a non-literal item", () => {
    const dir = makeScenarios({ A27: "export const surfaces = [WEBCHAT];\n" });
    expect(() => readScenarioSurfaces(dir, ["A27"])).toThrow(/A27\.ts: declare surfaces/);
  });
});

function makeScenarios(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-test-surfaces-"));
  directories.push(dir);
  for (const [id, source] of Object.entries(files)) writeFileSync(join(dir, `${id}.ts`), source);
  return dir;
}
