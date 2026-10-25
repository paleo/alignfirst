import type { LaunchEvidence } from "@alignfirst/docmap/invocation";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { resolveCommandForms } from "../src/command-form.js";
import { renderCodeGuide } from "../src/guide/code-guide.js";
import { ALIGNFIRST_BIN, makeSink, writeConfig } from "./helpers.js";

const NPX_ENV = {
  npm_config_user_agent: "npm/11.19.0 node/v26.0.0 linux x64",
  npm_command: "exec",
  npm_lifecycle_event: "npx",
};

// A global-form command: not preceded by `npx -y `, and not a usage title such as `aligndev code —`.
const GLOBAL_COMMAND = /(?<!npx -y )\baligndev (code|project|guide)\b(?! —)/;

const CONFIG = { platform: "codingAgent", code: { agent: "claude" } };

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("command forms", () => {
  it.each([
    ["node", {}, "aligndev", ["alignfirst"]],
    ["node", NPX_ENV, "npx -y aligndev", ["npx", "-y", "alignfirst"]],
    [
      "node",
      { npm_config_user_agent: "bun/1.4.4", npm_command: "exec" },
      "bunx aligndev",
      ["bunx", "alignfirst"],
    ],
    [
      "bun",
      { npm_config_user_agent: "bun/1.4.4", npm_command: "exec" },
      "bunx --bun aligndev",
      ["bunx", "--bun", "alignfirst"],
    ],
    [
      "node",
      { npm_config_user_agent: "pnpm/10", npm_command: "dlx" },
      "pnpm dlx aligndev",
      ["pnpm", "dlx", "alignfirst"],
    ],
    [
      "node",
      { npm_execpath: "/tools/yarn/bin/yarn.js" },
      "npx -y aligndev",
      ["npx", "-y", "alignfirst"],
    ],
  ] as const)("preserves %s invocation %j", (runtime, env, self, counterpart) => {
    const forms = resolveCommandForms(env, { runtime, env, cwd: "/tmp", executable: "/runtime" });
    expect(forms.aligndev).toBe(self);
    expect([forms.counterpart.executable, ...forms.counterpart.args]).toEqual(counterpart);
    const guide = renderCodeGuide({ platform: "codingAgent" }, "pi", undefined, undefined, forms);
    const row = guide.split("\n").find((line) => line.startsWith('{"action":"start"'));
    expect(JSON.parse(row ?? "").command).toContain(`${self} code new`);
    expect(guide).toContain(`${forms.alignfirst} guide <protocol>`);
  });

  it.each(["npm", "bun", "yarn"] as const)(
    "retains verified %s scripts only for self and JSON-quotes background commands",
    (manager) => {
      const home = makeHome();
      const name = "dev\"quoted\\path$&$`$'$$";
      const entryPoint = join(home, "entry.mjs");
      writeFileSync(entryPoint, "");
      const script = `node ${entryPoint}`;
      const manifest = join(home, "package.json");
      writeFileSync(manifest, JSON.stringify({ scripts: { [name]: script, af: "alignfirst" } }));
      const env = {
        npm_config_user_agent: `${manager}/1`,
        npm_command: manager === "yarn" ? undefined : manager === "npm" ? "run" : "run-script",
        npm_lifecycle_event: name,
        npm_lifecycle_script: script,
        npm_package_json: manifest,
      };
      const evidence: LaunchEvidence = {
        runtime: manager === "bun" ? "bun" : "node",
        env,
        cwd: home,
        entryPoint,
        executable: process.execPath,
        parentArgv: ["/bin/sh", "-c", script],
      };
      const forms = resolveCommandForms(env, evidence);
      expect(forms.invocation.launcher).toBe("projectScript");
      const quotedName = `'${name.replaceAll("'", "'\\''")}'`;
      expect(forms.aligndev).toBe(
        manager === "bun"
          ? `bun --bun run ${quotedName}`
          : `${manager} run ${quotedName}${manager === "npm" ? " --" : ""}`,
      );
      expect(forms.alignfirst).toBe(
        manager === "bun" ? "bunx --bun alignfirst" : "npx -y alignfirst",
      );
      const guide = renderCodeGuide({ platform: "codingAgent" }, "pi", undefined, undefined, forms);
      expect(guide).toContain(`${forms.aligndev} code status`);
      expect(guide).not.toContain("{{");
      const row = guide.split("\n").find((line) => line.startsWith('{"action":"start"'));
      const parsed = JSON.parse(row ?? "");
      expect(parsed.command).toBe(
        `${forms.aligndev} code new --message-file '/tmp/aligndev-request.txt' --quiet --meta 'a20bc7c1-c056-4d07-8cc2-90fe491a6df6'`,
      );
    },
  );
  it.each([
    ["the aligndev help", ["--help"]],
    ["the code usage", ["code", "--help"]],
    ["the project usage", ["project", "--help"]],
    ["the guide usage", ["guide", "--help"]],
    ["the playbook", ["guide"]],
    ["the delegation guide", ["guide", "code"]],
  ])("prints the npx forms in %s under npx, the global forms otherwise", async (_name, args) => {
    const npx = await run(args, NPX_ENV);
    expect(npx.code, npx.stderr).toBe(0);
    expect(npx.stdout).toContain("npx -y aligndev ");
    expect(npx.stdout).not.toMatch(GLOBAL_COMMAND);

    const global = await run(args, {});
    expect(global.code, global.stderr).toBe(0);
    expect(global.stdout).not.toContain("npx -y");
    expect(global.stdout).toMatch(GLOBAL_COMMAND);
  });

  it("prints the npx alignfirst form in the code usage and the delegation guide", async () => {
    for (const args of [
      ["code", "--help"],
      ["guide", "code"],
    ]) {
      const npx = await run(args, NPX_ENV);
      expect(npx.stdout).toContain("`npx -y alignfirst ticket --side`");
      const global = await run(args, {});
      expect(global.stdout).toContain("`alignfirst ticket --side`");
    }
  });

  it("uses the same command form in Pi background commands and result retrieval", async () => {
    for (const env of [{}, NPX_ENV]) {
      const result = await run(["guide", "code"], env);
      const command = env === NPX_ENV ? "npx -y aligndev" : "aligndev";
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(`"command":"${command} code new --message-file`);
      expect(result.stdout).toContain(
        `${command} code resume <sessionId> --message-file <path> --quiet --meta <fresh-run-key>`,
      );
      expect(result.stdout).toContain(`${command} code status <exact-file> --result`);
      expect(result.stdout).toContain(`${command} code status --meta <unique-run-key> --result`);
    }
  });

  it("spawns alignfirst through npx under npx", async () => {
    const home = makeHome();
    const bin = join(home, "bin");
    const log = join(home, "npx.log");
    writeFileSync(
      join(bin, "npx"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 1\n`,
    );
    chmodSync(join(bin, "npx"), 0o755);

    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aligndev", "code", "status", "--no-ticket"],
      cwd: home,
      env: { ...NPX_ENV, PATH: bin, HOME: home },
      home,
      stdout: makeSink(),
      stderr,
    });

    expect(code).toBe(1);
    expect(readFileSync(log, "utf8")).toBe("-y alignfirst config --json\n");
  });
});

async function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = makeHome();
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await main({
    argv: ["node", "aligndev", ...args],
    cwd: home,
    env: { ...env, HOME: home },
    home,
    alignfirstCommand: [process.execPath, ALIGNFIRST_BIN],
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

// A home with the config and an empty `bin/` directory.
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aligndev-forms-"));
  homes.push(home);
  writeConfig(home, CONFIG);
  mkdirSync(join(home, "bin"));
  return home;
}
