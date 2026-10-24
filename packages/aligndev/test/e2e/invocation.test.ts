import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { writeConfig } from "../helpers.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const temporary: string[] = [];
const yarn = process.env.YARN_CLASSIC ?? "yarn";
const yarnVersion = spawnSync(yarn, ["--version"], {
  cwd: tmpdir(),
  env: { ...process.env, COREPACK_ENABLE_NETWORK: "0" },
  encoding: "utf8",
  timeout: 10_000,
});
const hasYarnClassic = yarnVersion.status === 0 && /^1\./.test(yarnVersion.stdout.trim());

interface Fixture {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

beforeAll(() => {
  for (const workspace of ["@alignfirst/docmap", "alignfirst", "aligndev"]) {
    execFileSync("npm", ["run", "build", "--workspace", workspace], { cwd: root, stdio: "pipe" });
  }
}, 60_000);

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("built script invocation", () => {
  it("round-trips dollar-bearing npm scripts through commands, guides and background JSON", () => {
    const fixture = makeFixture();
    const guide = runScript("npm", fixture, "ad$&", ["guide", "code"]);
    expect(guide.status, guide.stderr).toBe(0);
    expect(guide.stdout).toContain("npm run 'ad$&' -- code status");
    expect(guide.stdout).not.toContain("{{");
    const row = guide.stdout.split("\n").find((line) => line.startsWith('{"action":"start"'));
    const command: string = JSON.parse(row ?? "").command;
    const self = command.slice(0, command.indexOf(" code new"));
    expect(self).toBe("npm run 'ad$&' --");

    const followup = spawnSync("/bin/sh", ["-c", `${self} code status --help`], {
      ...fixture,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(followup.status, followup.stderr).toBe(0);
    expect(followup.stdout).toContain("npm run 'ad$&' -- code status");

    for (const args of [["context"], ["guide", "spec"], ["docmap", "--guide"]]) {
      const result = runScript("npm", fixture, "af$&", args);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("npm run 'af$&' --");
      expect(result.stdout).not.toContain("{{");
    }
    const docmap = runScript("npm", fixture, "dm$&", ["--guide"]);
    expect(docmap.status, docmap.stderr).toBe(0);
    expect(docmap.stdout).toContain("npm run 'dm$&' -- --check");
    expect(docmap.stdout).not.toContain("{{");
  });

  it.skipIf(!hasYarnClassic)(
    "reaches sessions through npx from a real Yarn Classic project script",
    () => {
      const fixture = makeFixture();
      const guide = runScript(yarn, fixture, "ad$&", ["guide", "code"]);
      expect(guide.status, guide.stderr).toBe(0);
      expect(guide.stdout).toContain("npx -y aligndev code status");
      expect(guide.stdout).toContain("npx -y alignfirst guide <protocol>");
      expect(guide.stdout).not.toContain("yarn dlx");
      expect(guide.stdout).not.toContain("{{");

      const status = runScript(yarn, fixture, "ad$&", ["code", "status", "--no-ticket"]);
      // No record exists: reaching this diagnostic proves the real counterpart config call worked.
      expect(status.status).toBe(1);
      expect(status.stderr).toContain("Error: no session file under");
      expect(status.stderr).not.toContain('Command "dlx" not found');
    },
  );
});

function makeFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "script-invocation-e2e-"));
  temporary.push(home);
  const cwd = join(home, "project");
  const bin = join(cwd, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  execFileSync("git", ["init", "--quiet", cwd]);
  for (const [name, entry] of [
    ["aligndev", "aligndev/bin/aligndev.mjs"],
    ["alignfirst", "alignfirst/bin/alignfirst.mjs"],
    ["docmap", "docmap/bin/docmap.mjs"],
  ]) {
    symlinkSync(join(root, "packages", entry), join(bin, name));
  }
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { "ad$&": "aligndev", "af$&": "alignfirst", "dm$&": "docmap" },
    }),
  );
  writeConfig(home, { platform: "codingAgent", code: { agent: "pi" } });
  // Yarn Classic leaves some npm metadata untouched; start as an ordinary shell launch.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_")) delete env[key];
  }
  return { cwd, env: { ...env, HOME: home, npm_config_offline: "true" } };
}

function runScript(manager: string, fixture: Fixture, script: string, args: string[]) {
  return spawnSync(manager, ["run", script, ...(manager === "npm" ? ["--"] : []), ...args], {
    ...fixture,
    encoding: "utf8",
    timeout: 30_000,
  });
}
