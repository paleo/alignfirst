import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("context command", () => {
  it("prints the conventions, the docmap sections, then the protocols section", async () => {
    const cwd = temp();
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "docs", "topic.md"), "---\ntitle: Topic\n---\n\n# Topic\n");
    const result = await runMain(["context"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("# Project Conventions\n\nTicket IDs:")).toBe(true);
    expect(result.stdout).toContain(
      "Default branch: unresolved; ask before default-branch operations.\n\n# Docmap Usage\n\ndocmap — browse",
    );
    expect(result.stdout).toContain("`docs/topic.md` — Topic\n\n# AlignFirst Protocols\n\n");
    expect(result.stdout).toContain("run `alignfirst guide <protocol>` and follow it");
    expect(result.stdout).toContain("Catch up (`alcatchup`) — run `alignfirst ticket --catchup`");
    expect(result.stdout).not.toContain("{{");
  });

  it("skips the docmap sections without a docs directory", async () => {
    const result = await runMain(["context"], { cwd: temp() });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Docmap");
    expect(result.stdout).toContain(
      "Default branch: unresolved; ask before default-branch operations.\n\n# AlignFirst Protocols\n\n",
    );
  });

  it("renders the npx command form", async () => {
    const result = await runMain(["context"], {
      cwd: temp(),
      env: { npm_config_user_agent: "npm/10.0.0 node/v22.0.0" },
    });
    expect(result.stdout).toContain("run `npx -y alignfirst guide <protocol>` and follow it");
  });
});

function temp(): string {
  const dir = makeTempDir("alignfirst-context-");
  dirs.push(dir);
  return dir;
}
