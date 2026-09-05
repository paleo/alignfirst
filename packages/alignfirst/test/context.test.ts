import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("context command", () => {
  it("prints conventions, one blank line, then the documentation map", async () => {
    const cwd = temp();
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "docs", "topic.md"), "---\ntitle: Topic\n---\n\n# Topic\n");
    const result = await runMain(["context"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Default branch: unresolved; ask before default-branch operations.\n\ndocmap — browse",
    );
    expect(result.stdout).toContain("`docs/topic.md` — Topic");
  });

  it("keeps docmap's missing-documentation result", async () => {
    const result = await runMain(["context"], { cwd: temp() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No documentation folder");
  });
});

function temp(): string {
  const dir = makeTempDir("alignfirst-context-");
  dirs.push(dir);
  return dir;
}
