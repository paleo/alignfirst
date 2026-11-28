import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { writeConfig } from "../helpers.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const temporary: string[] = [];
const HARNESS_MARKERS = [
  "ALIGNDEV_ASSISTANT_HARNESS",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "PI_CODING_AGENT",
  "AI_AGENT",
  "ANTIGRAVITY_AGENT",
  "OPENCLAW_SHELL",
];
interface Fixture {
  cwd: string;
  env: NodeJS.ProcessEnv;
  // Written by the counterpart's same-named npm script, which must never run.
  marker: string;
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("built script invocation", () => {
  it("round-trips a dollar-bearing npm script and probes the counterpart binary, not its script", () => {
    const fixture = makeFixture();
    const guide = runScript(fixture, ["guide", "code"]);
    expect(guide.status, guide.stderr).toBe(0);
    expect(guide.stdout).toContain("npx -y alignfirst guide <protocol>");
    const row = guide.stdout.split("\n").find((line) => line.startsWith('{"action":"start"'));
    const command: string = JSON.parse(row ?? "").command;
    const self = command.slice(0, command.indexOf(" code new"));
    expect(self).toBe("npm run 'ad$&' --");

    const followup = spawnSync("/bin/sh", ["-c", `${self} code status --help`], {
      cwd: fixture.cwd,
      env: fixture.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(followup.status, followup.stderr).toBe(0);

    const sessions = join(fixture.cwd, ".plans", "_aligndev");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "20260829-115529.md"),
      "---\nsessionId: script-session\nstatus: succeeded\n---\n",
    );
    const status = runScript(fixture, ["code", "status", "--no-ticket"]);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("sessionId: script-session");
    expect(existsSync(fixture.marker)).toBe(false);
  });
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
  ]) {
    symlinkSync(join(root, "packages", entry), join(bin, name));
  }
  const marker = join(home, "counterpart-script-ran");
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { "ad$&": "aligndev", alignfirst: `touch '${marker}' && alignfirst` },
    }),
  );
  writeConfig(home, { code: { harness: "pi" } });
  // Start as an ordinary shell launch, outside any assistant's harness.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_")) delete env[key];
  }
  for (const key of HARNESS_MARKERS) delete env[key];
  return { cwd, env: { ...env, HOME: home, npm_config_offline: "true" }, marker };
}

function runScript(fixture: Fixture, args: string[]) {
  return spawnSync("npm", ["run", "ad$&", "--", ...args], {
    cwd: fixture.cwd,
    env: fixture.env,
    encoding: "utf8",
    timeout: 30_000,
  });
}
