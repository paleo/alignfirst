import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createExecutableModelResolver } from "../../src/code/models.js";
import { createQuotaReader } from "../../src/code/quota.js";
import { buildAgentEnv } from "../../src/code/run-agent.js";
import {
  type CodingProfile,
  type LoadedConfig,
  resolveCodeConfig,
  resolveQuotaConfig,
} from "../../src/config.js";

let root: string;
let shim: string;
let bin: string;
let bun: string;
let caller: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aligndev-external-env-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  bun = join(root, "bun");
  writeFileSync(bun, "#!/bin/sh\nexit 89\n", { mode: 0o755 });
  shim = makeShim("bun-node-1000-abcdef123");
  caller = Object.freeze({
    HOME: root,
    PATH: [shim, bin].join(delimiter),
    NODE: shim,
    npm_node_execpath: shim,
    CODEX_THREAD_ID: "parent",
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("external native environment boundary", () => {
  it("cleans verified inherited shims and their runtime metadata without mutating the caller", () => {
    expect(buildAgentEnv(caller, [])).toEqual({ HOME: root, PATH: bin });
    expect(() => execFileSync("node", ["-v"], { env: caller })).toThrow();
  });

  it("removes repeated and nested launcher shims while preserving PATH order and empty entries", () => {
    const other = makeShim("bun-node-1000-fedcba321");
    const path = ["", shim, bin, other, shim, "", bin].join(delimiter);
    const env = buildAgentEnv({ PATH: path, NODE: bin, npm_node_execpath: process.execPath }, []);
    expect(env).toEqual({
      PATH: ["", bin, "", bin].join(delimiter),
      NODE: bin,
      npm_node_execpath: process.execPath,
    });
  });

  it("identifies the older uid-less shim layout and bunx executable target", () => {
    const older = makeShim("bun-node-274e01c73");
    const target = join(root, "bunx.exe");
    writeFileSync(target, "fixture");
    for (const name of ["bun", "node"]) {
      unlinkSync(join(older, name));
      symlinkSync(target, join(older, name));
    }
    expect(buildAgentEnv({ PATH: [older, bin].join(delimiter) }, []).PATH).toBe(bin);
  });

  it("preserves ordinary Bun installations, including a deliberate inherited node alias", () => {
    const deliberate = makeShim("bun-installation");
    const path = [deliberate, bin].join(delimiter);
    expect(buildAgentEnv({ PATH: path, NODE: deliberate }, [])).toEqual({
      PATH: path,
      NODE: deliberate,
    });
  });

  it.each(["missing", "broken", "regular", "differentTarget", "notBun"])(
    "keeps a bun-node-named directory with %s runtime evidence",
    (kind) => {
      unlinkSync(join(shim, "node"));
      if (kind === "broken") symlinkSync(join(root, "absent"), join(shim, "node"));
      if (kind === "regular") writeFileSync(join(shim, "node"), "node");
      if (kind === "differentTarget") symlinkSync(process.execPath, join(shim, "node"));
      if (kind === "notBun") {
        unlinkSync(join(shim, "bun"));
        symlinkSync(process.execPath, join(shim, "node"));
        symlinkSync(process.execPath, join(shim, "bun"));
      }
      expect(buildAgentEnv(caller, []).PATH).toBe(caller.PATH);
    },
  );

  it("handles absent and empty PATH without introducing a default", () => {
    expect(buildAgentEnv({}, [])).toEqual({});
    expect(buildAgentEnv({ PATH: "" }, [])).toEqual({ PATH: "" });
    expect(buildAgentEnv({ PATH: shim }, [])).toEqual({ PATH: "" });
  });

  it("applies unset, literal overrides and required values after baseline cleanup", () => {
    expect(buildAgentEnv(caller, ["PATH"])).toEqual({ HOME: root });
    expect(buildAgentEnv(caller, [], { PATH: [shim, bin].join(delimiter), NODE: shim })).toEqual({
      HOME: root,
      PATH: caller.PATH,
      NODE: shim,
    });
    expect(buildAgentEnv(caller, [], { PATH: bin }, { PATH: shim }).PATH).toBe(shim);
  });

  it.each(["claude", "codex", "pi"] as const)(
    "cleans the %s profile baseline and retains explicit coding PATH configuration",
    (agent) => {
      const code = resolveCodeConfig(config({ agent }), caller);
      expect(code.childEnv.PATH).toBe(bin);
      const deliberate = resolveCodeConfig(config({ agent, env: { PATH: shim } }), caller);
      expect(deliberate.childEnv.PATH).toBe(shim);
      expect(
        resolveCodeConfig(config({ agent, unset: ["PATH"] }), caller).childEnv.PATH,
      ).toBeUndefined();
    },
  );

  it.each(["claude", "codex"] as const)(
    "cleans explicit %s quota independently, then respects its own PATH override or unset",
    (source) => {
      for (const mode of ["inherit", "override", "unset"] as const) {
        const code = resolveCodeConfig(
          config({
            agent: "pi",
            env: { PATH: shim },
            quota: {
              source,
              ...(mode === "override" ? { env: { PATH: shim } } : {}),
              ...(mode === "unset" ? { unset: ["PATH"] } : {}),
            },
          }),
          caller,
        );
        const quota = resolveQuotaConfig(code, caller);
        if (quota.source === "none") throw new Error("unexpected disabled quota");
        expect(code.childEnv.PATH).toBe(shim);
        expect(quota.env.PATH).toBe(
          mode === "inherit" ? bin : mode === "override" ? shim : undefined,
        );
        expect(quota.env.NODE).toBeUndefined();
        expect(quota.env.CODEX_THREAD_ID).toBeUndefined();
      }
    },
  );

  it("runs Node-shebang model discovery and native quota under Node despite an inherited shim", async () => {
    writeNativeFixture(
      "codex",
      `
if (process.argv[2] === "debug") {
  console.log(JSON.stringify({models: [{slug: "gpt-9-sol"}]}));
} else {
  require("node:readline").createInterface({input: process.stdin}).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") console.log(JSON.stringify({id: 0, result: {}}));
    if (message.method === "account/rateLimits/read") console.log(JSON.stringify({
      id: 1, result: {rateLimits: {primary: {usedPercent: 15, windowDurationMins: 300}}}
    }));
  });
}
`,
    );
    writeNativeFixture(
      "claude",
      `
console.log(JSON.stringify({subtype: "success", result: "Current session: 25% used"}));
`,
    );
    const code = resolveCodeConfig(config({ agent: "codex" }), caller);
    await expect(
      createExecutableModelResolver()("codex", "sol", { cwd: root, env: code.childEnv }),
    ).resolves.toBe("gpt-9-sol");
    const reader = createQuotaReader(undefined, 2000);
    for (const source of ["claude", "codex"] as const) {
      const quota = resolveQuotaConfig(
        resolveCodeConfig(config({ agent: source }), caller),
        caller,
      );
      if (quota.source === "none") throw new Error("unexpected disabled quota");
      await expect(reader(quota.source, { cwd: root, env: quota.env })).resolves.toContain(
        source === "claude" ? "25% used" : "15% used",
      );
    }
  });
});

function makeShim(name: string): string {
  const directory = join(root, name);
  mkdirSync(directory);
  symlinkSync(bun, join(directory, "node"));
  symlinkSync(bun, join(directory, "bun"));
  return directory;
}

function config(profile: CodingProfile): LoadedConfig {
  return {
    path: join(root, "settings.json"),
    platform: "codingAgent",
    code: { profile: "test", profiles: { test: profile } },
  };
}

function writeNativeFixture(name: string, script: string): void {
  writeFileSync(
    join(bin, name),
    `#!/usr/bin/env node\nif (process.versions.bun !== undefined) process.exit(88);\n${script}`,
    { mode: 0o755 },
  );
}
