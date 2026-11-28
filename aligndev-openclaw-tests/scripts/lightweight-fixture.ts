import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OLD_HISTORY = "# Old project history\nKeep these exact bytes in the project.\n";

export interface LightweightFixtureOptions {
  repo: string;
  plans: "shared" | "missing" | "tracked";
}

export function prepareLightweightFixture({ repo, plans }: LightweightFixtureOptions): void {
  for (const path of ["scripts/workspace", "node_modules", "pnpm-lock.yaml", "home-page.mjs"]) {
    rmSync(join(repo, path), { recursive: true, force: true });
  }
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify(
      {
        name: "nimbus-lightweight-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test label.test.mjs" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(repo, "label.mjs"), 'export const label = "Export";\n');
  writeFileSync(
    join(repo, "label.test.mjs"),
    `import assert from "node:assert/strict";
import { test } from "node:test";
import { label } from "./label.mjs";
test("export label", () => assert.equal(label, "Export"));
`,
  );
  const instructions =
    "# Nimbus\n\nThis is a small ESM library. Run `npm test` to test it. No install or build is needed.\nUse `alignfirst workspace` in manifest-free mode. Readiness is protocol-ready; there is no dev server or port allocation.\nUse the AlignDev playbook for isolated branch work.\n";
  writeFileSync(join(repo, "README.md"), instructions);
  writeFileSync(join(repo, "ASSISTANTS.md"), instructions);
  const configPath = join(repo, "alignfirst.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  delete config.workspace;
  delete config.devServer;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  rmSync(join(repo, ".plans"), { recursive: true, force: true });
  mkdirSync(join(repo, ".local"), { recursive: true });
  writeFileSync(join(repo, ".local/keep.txt"), "shared local data\n");
  if (plans !== "missing") {
    mkdirSync(join(repo, ".plans"), { recursive: true });
    if (plans === "tracked") writeFileSync(join(repo, ".plans/old-history.md"), OLD_HISTORY);
  }
  git(repo, "add", "-A");
  if (plans === "tracked") git(repo, "add", "-f", ".plans/old-history.md");
  git(repo, "commit", "-qm", "prepare lightweight fixture");
  git(repo, "push", "-q", "origin", "main");
}

export function assertCapturedRequest(actual: string): void {
  const normalized = normalizeRequest(actual);
  for (const requirement of [
    /nimbus/iu,
    /sans ticket/iu,
    /remplac\w* Export par Download dans label\.mjs/iu,
    /adapt\w* (?:le test )?label\.test\.mjs/iu,
    /exécut\w* npm test/iu,
    /ne (?:pousse rien|rien pousser)/iu,
  ]) {
    if (!requirement.test(normalized)) {
      throw new Error(`Captured request omitted ${requirement}: ${JSON.stringify(actual)}`);
    }
  }
}

function normalizeRequest(value: string): string {
  return value
    .replaceAll(/[‘’]/gu, "'")
    .replaceAll(/[«»"`]/gu, "")
    .replaceAll("sans ticket externe", "sans ticket")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@local",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@local",
    },
    stdio: "pipe",
  }).trim();
}
