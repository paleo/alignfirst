import type { LaunchEvidence } from "@alignfirst/docmap/invocation";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { resolveCommandForms } from "../src/command-form.js";
import { renderCodeGuide } from "../src/guide/code-guide.js";
import { makeSink, NPX_ENV, writeConfig } from "./helpers.js";

const CONFIG = { code: { harness: "claude" } };

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("command forms", () => {
  it.each([
    ["node", {}, "aligndev", ["alignfirst"]],
    ["node", NPX_ENV, "npx -y aligndev", ["npx", "-y", "alignfirst"]],
    [
      "bun",
      { npm_config_user_agent: "bun/1.4.4", npm_command: "exec" },
      "bunx --bun aligndev",
      ["bunx", "--bun", "alignfirst"],
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
    const guide = renderCodeGuide({
      active: { platform: "codingAgent" },
      forms,
      harness: "pi",
      models: undefined,
      efforts: [],
    });
    const row = guide.split("\n").find((line) => line.startsWith('{"action":"start"'));
    expect(JSON.parse(row ?? "").command).toContain(`${self} code new`);
  });

  it.each(["npm", "bun"] as const)(
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
        npm_command: manager === "npm" ? "run" : "run-script",
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
      const guide = renderCodeGuide({
        active: { platform: "codingAgent" },
        forms,
        harness: "pi",
        models: undefined,
        efforts: [],
      });
      const row = guide.split("\n").find((line) => line.startsWith('{"action":"start"'));
      const parsed = JSON.parse(row ?? "");
      expect(parsed.command).toContain(forms.aligndev);
    },
  );
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

// A home with the config and an empty `bin/` directory.
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aligndev-forms-"));
  homes.push(home);
  writeConfig(home, CONFIG);
  mkdirSync(join(home, "bin"));
  return home;
}
