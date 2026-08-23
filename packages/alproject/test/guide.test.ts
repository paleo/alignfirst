import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderGuide } from "../src/guide.js";

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir !== undefined) {
    chmodSync(fixtureDir, 0o700);
    rmSync(fixtureDir, { force: true, recursive: true });
  }
  fixtureDir = undefined;
});

describe("renderGuide", () => {
  it("renders the complete generic guide without template markers", () => {
    const root = makeRoot();
    const guide = renderGuide(root);

    expect(guide).toMatch(/^# alproject guide\n/);
    for (const content of [
      "alproject list",
      "--json",
      "alproject register <path>",
      "alproject unregister <path>",
      "--ports-per-workspace",
      "does not delete",
    ]) {
      expect(guide).toContain(content);
    }
    expect(guide).not.toMatch(/\{\{[^}]+\}\}/u);
  });

  it("appends custom Markdown verbatim after an empty line", () => {
    const root = makeRoot();
    const custom = "# Team procedure\n\nKeep {{consumer-marker}} and trailing space. \n";
    writeFileSync(join(root, "alproject-guide.md"), custom);

    const guide = renderGuide(root);

    expect(guide.endsWith(`\n\n${custom}`)).toBe(true);
    expect(guide).not.toContain("\n\n\n");
  });

  it("treats unreadable custom-guide content as an error", () => {
    const root = makeRoot();
    mkdirSync(join(root, "alproject-guide.md"));

    expect(() => renderGuide(root)).toThrow(/Cannot read custom guide/);
  });
});

function makeRoot(): string {
  fixtureDir = mkdtempSync(join(tmpdir(), "alproject-guide-"));
  return fixtureDir;
}
