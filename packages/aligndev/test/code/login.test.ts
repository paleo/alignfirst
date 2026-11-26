import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CODING_AGENTS } from "../../src/code/coding-agent.js";
import { renderLoginInstructions } from "../../src/code/login.js";
import { type CodeConfig, loadConfig, resolveCodeConfig } from "../../src/config.js";
import { writeSettings } from "../helpers.js";

interface LoginCase {
  name: string;
  profile: object;
  // The native directory variable, absent for Antigravity.
  variable?: string;
  // The assistant's session holds the variable.
  inherited?: boolean;
}

// What the fake native CLI saw when the login command ran.
interface Observed {
  executable: string;
  args: string[];
  cwd: string;
  directory?: string;
  token?: string;
}

const CASES: LoginCase[] = [
  {
    name: "a string configDir",
    profile: { harness: "claude", configDir: "~/it's a store" },
    variable: "CLAUDE_CONFIG_DIR",
    inherited: true,
  },
  {
    name: "a null configDir",
    profile: { harness: "codex", configDir: null },
    variable: "CODEX_HOME",
    inherited: true,
  },
  {
    name: "an inherited directory variable",
    profile: { harness: "pi" },
    variable: "PI_CODING_AGENT_DIR",
    inherited: true,
  },
  { name: "no directory variable", profile: { harness: "claude" }, variable: "CLAUDE_CONFIG_DIR" },
  { name: "Antigravity's fixed store", profile: { harness: "agy" } },
];

describe("login instructions", () => {
  let base: string;
  let home: string;
  let bin: string;
  let cwd: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "aligndev-login-")));
    home = join(base, "home");
    bin = join(base, "bin");
    cwd = join(base, "it's a\n\u0085project");
    for (const directory of [home, bin, cwd]) mkdirSync(directory);
    for (const agent of CODING_AGENTS) installFakeAgent(agent);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it.each(CASES)("log in under the agent's native configuration with $name", (loginCase) => {
    const { variable, inherited = false } = loginCase;
    const assistantEnv: NodeJS.ProcessEnv = { HOME: home, TOKEN: "assistant-token" };
    if (variable !== undefined && inherited) assistantEnv[variable] = join(base, "assistant store");
    const code = resolve({ ...loginCase.profile, unset: ["TOKEN"] }, assistantEnv);

    const observed = runLoginCommand(renderLoginInstructions(code, cwd), {
      TOKEN: "administrator-token",
      ...(variable === undefined ? {} : { [variable]: join(base, "administrator store") }),
    });

    expect(observed).toEqual({
      executable: code.harness,
      args: code.harness === "codex" ? ["login"] : [],
      cwd,
      ...(variable === undefined ? {} : { directory: code.childEnv[variable] }),
    });
  });

  it("omit every value a profile sets", () => {
    const code = resolve(
      {
        harness: "claude",
        env: {
          CLAUDE_CONFIG_DIR: "private-store",
          HOME: "private-home",
          API_ROUTE: "private-route",
        },
      },
      { HOME: home, ANTHROPIC_API_KEY: "private-key" },
    );
    const instructions = renderLoginInstructions(code, cwd);
    for (const value of ["private-store", "private-home", "private-route", "private-key"]) {
      expect(instructions).not.toContain(value);
    }
    expect(instructions).toContain("API_ROUTE=");
  });

  it("refuse to start the CLI until an omitted value is replaced", () => {
    const code = resolve(
      { harness: "claude", env: { API_ROUTE: "private-route" } },
      { HOME: home },
    );

    const result = spawnLoginCommand(renderLoginInstructions(code, cwd), {});

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  function resolve(profile: object, env: NodeJS.ProcessEnv): CodeConfig {
    writeSettings(home, { code: { fallbackProfile: "test", profiles: { test: profile } } });
    return resolveCodeConfig(loadConfig(home, "alignfirst"), env);
  }

  // Runs the command line of the instructions in the administrator's shell.
  function runLoginCommand(instructions: string, administratorEnv: NodeJS.ProcessEnv): Observed {
    const result = spawnLoginCommand(instructions, administratorEnv);
    if (result.status !== 0) throw new Error(`${instructions}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  }

  // The administrator's shell has no locale: the command must not depend on one.
  function spawnLoginCommand(
    instructions: string,
    administratorEnv: NodeJS.ProcessEnv,
  ): SpawnSyncReturns<string> {
    const [command, ...others] = instructions.split("\n").filter((line) => line.startsWith("  "));
    if (command === undefined || others.length > 0) throw new Error(instructions);
    return spawnSync("bash", ["-c", command], {
      cwd: base,
      env: { ...administratorEnv, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    });
  }

  function installFakeAgent(agent: string): void {
    writeFileSync(
      join(bin, agent),
      `#!${process.execPath}
const directory = [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME, process.env.PI_CODING_AGENT_DIR].find((value) => value !== undefined);
process.stdout.write(JSON.stringify({ executable: ${JSON.stringify(agent)}, args: process.argv.slice(2), cwd: process.cwd(), directory, token: process.env.TOKEN }));
`,
      { mode: 0o755 },
    );
  }
});
