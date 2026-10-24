import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCommand,
  invocationCommand,
  type LaunchEvidence,
  packageCommand,
  renderCommand,
  resolveInvocation,
  scriptCommand,
} from "../src/invocation.js";

const target = { packageName: "@alignfirst/docmap", binaryName: "docmap" };
const other = { packageName: "alignfirst", binaryName: "alignfirst" };
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "invocation spaces-"));
  mkdirSync(join(directory, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(directory, "entry.mjs"), "");
  symlinkSync(join(directory, "entry.mjs"), join(directory, "node_modules", ".bin", "docmap"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { docs: "docmap" } }));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("package execution and actual runtime", () => {
  it.each([
    ["npm/11.19.0 node/v26.8.1 linux x64", "exec", "npx", "node", "npx -y @alignfirst/docmap"],
    ["npm/12.2.0 node/v26.8.1 linux x64", "exec", "npx", "bun", "bunx --bun @alignfirst/docmap"],
    ["bun/1.4.4 npm/? node/v26.3.0 linux x64", "exec", "bunx", "node", "bunx @alignfirst/docmap"],
    [
      "bun/1.4.4 npm/? node/v26.3.0 linux x64",
      "exec",
      "bunx",
      "bun",
      "bunx --bun @alignfirst/docmap",
    ],
    ["bun/1.4.4 npm/?", "run-script", undefined, "bun", "bunx --bun @alignfirst/docmap"],
    ["pnpm/10.0.0 npm/?", "dlx", undefined, "node", "pnpm dlx @alignfirst/docmap"],
    ["yarn/4.0.0 npm/?", "dlx", undefined, "node", "yarn dlx @alignfirst/docmap"],
  ] as const)("%s %s %s under %s", (agent, command, event, runtime, expected) => {
    const input = evidence({
      npm_config_user_agent: agent,
      npm_command: command,
      npm_lifecycle_event: event,
    });
    input.runtime = runtime;
    for (const lock of [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
    ]) {
      writeFileSync(join(directory, lock), "");
    }
    const invocation = resolveInvocation(target, input);
    expect(invocation.launcher).toBe("packageRunner");
    expect(invocationCommand(invocation).base).toBe(expected);
  });

  it.each([
    [undefined, "node", "docmap"],
    ["", "node", "docmap"],
    ["unknown/1", "node", "docmap"],
    ["arbitrary nonempty", "node", "docmap"],
    [undefined, "bun", "bunx --bun @alignfirst/docmap"],
    ["npm/12.2.0", "bun", "bunx --bun @alignfirst/docmap"],
    ["npm/12.2.0", "node", "npx -y @alignfirst/docmap"],
    ["bun/1.4.4", "node", "bunx @alignfirst/docmap"],
    ["pnpm/10", "node", "pnpm dlx @alignfirst/docmap"],
    ["yarn/1.22.22", "node", "yarn dlx @alignfirst/docmap"],
  ] as const)("agent-only %s runtime %s", (agent, runtime, expected) => {
    const input = evidence({ npm_config_user_agent: agent });
    input.runtime = runtime;
    expect(invocationCommand(resolveInvocation(target, input)).base).toBe(expected);
  });

  it("can identify npm from launcher metadata but never executes runtime shims", () => {
    const input = evidence({
      npm_execpath: "/tools/npm/bin/npm-cli.js",
      NODE: "/bun/shims",
      npm_node_execpath: "/bun/shims",
    });
    expect(invocationCommand(resolveInvocation(target, input)).executable).toBe("npx");
  });
});

describe("verified owning scripts", () => {
  it.each([
    ["npm", "run", "npm run docs", "npm run docs --"],
    ["bun", "run-script", "bun run docs", "bun run docs"],
    ["pnpm", undefined, "pnpm run docs", "pnpm run docs"],
    ["yarn", undefined, "yarn run docs", "yarn run docs"],
  ])("retains %s scripts", (manager, mode, base, withArgs) => {
    const input = scriptEvidence(manager, mode);
    const invocation = resolveInvocation(target, input);
    expect(invocation.launcher).toBe("projectScript");
    expect(invocationCommand(invocation)).toMatchObject({ base, withArgs });
    expect(packageCommand(invocation, other).base).not.toContain("run docs");
    expect(packageCommand(invocation, target).base).not.toContain("run docs");
  });

  it("forces Bun for Bun scripts, and falls back for npm-hosted Bun scripts", () => {
    const bun = scriptEvidence("bun", "run-script");
    bun.runtime = "bun";
    expect(invocationCommand(resolveInvocation(target, bun)).base).toBe("bun --bun run docs");
    const npm = scriptEvidence("npm", "run");
    npm.runtime = "bun";
    expect(invocationCommand(resolveInvocation(target, npm)).base).toBe(
      "bunx --bun @alignfirst/docmap",
    );
  });

  it("uses the manifest directory from nested cwd and quotes its location and custom script name", () => {
    const name = "my docs";
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { [name]: 'node "entry.mjs"' } }),
    );
    const input = scriptEvidence("npm", "run");
    input.env = {
      ...input.env,
      npm_lifecycle_event: name,
      npm_lifecycle_script: 'node "entry.mjs"',
    };
    input.parentArgv = ["sh", "-c", 'node "entry.mjs" --help'];
    input.cwd = join(directory, "nested");
    const command = invocationCommand(resolveInvocation(target, input));
    expect(command.base).toBe(`npm --prefix '${directory}' run 'my docs'`);
    expect(command.args).toEqual(["--prefix", directory, "run", name, "--"]);
  });

  it.each(["node entry.mjs", "bun entry.mjs", "'./entry.mjs'"])(
    "accepts transparent wrappers %s",
    (script) => {
      setScript(script);
      const input = scriptEvidence("bun", "run-script");
      input.env = { ...input.env, npm_lifecycle_script: script };
      expect(resolveInvocation(target, input).launcher).toBe("projectScript");
    },
  );

  it.each([
    "docmap --help",
    "docmap && echo yes",
    "FOO=bar docmap",
    "node entry.mjs --help",
    "node other.mjs",
    "bun --bun entry.mjs",
    "echo $(docmap)",
    "docmap | cat",
  ])("rejects compound/fixed/unverified script %s", (script) => {
    setScript(script);
    const input = scriptEvidence("npm", "run");
    input.env = { ...input.env, npm_lifecycle_script: script };
    input.parentArgv = ["sh", "-c", script];
    expect(resolveInvocation(target, input).launcher).toBe("packageRunner");
  });

  it("verifies quoted entry paths containing spaces", () => {
    const entry = join(directory, "my entry.mjs");
    writeFileSync(entry, "");
    setScript('node "my entry.mjs"');
    const input = scriptEvidence("npm", "run");
    input.entryPoint = entry;
    input.env = { ...input.env, npm_lifecycle_script: 'node "my entry.mjs"' };
    input.parentArgv = ["sh", "-c", 'node "my entry.mjs" --help'];
    expect(resolveInvocation(target, input).launcher).toBe("projectScript");
  });

  it.each(["", "-unsafe"])("rejects unsafe script names %s", (name) => {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { [name]: "docmap" } }),
    );
    const input = scriptEvidence("npm", "run");
    input.env = { ...input.env, npm_lifecycle_event: name };
    expect(resolveInvocation(target, input).launcher).toBe("packageRunner");
  });

  it("rejects different-target script metadata", () => {
    expect(resolveInvocation(other, scriptEvidence("npm", "run")).launcher).toBe("packageRunner");
  });

  it.each([
    undefined,
    ["node", "/ancestor.mjs"],
    ["bun", "run", "different"],
    ["npm run ancestor"],
  ])("rejects even manifest-valid same-target ancestor metadata with parent %s", (parentArgv) => {
    const input = scriptEvidence("npm", "run");
    input.parentArgv = parentArgv;
    expect(resolveInvocation(target, input).launcher).toBe("packageRunner");
  });

  it("explicit exec wins even over manifest-valid same-target metadata", () => {
    const input = scriptEvidence("npm", "exec");
    expect(resolveInvocation(target, input).launcher).toBe("packageRunner");
  });

  it.each(["missing", "malformed", "stale", "noEvent", "noManifest", "noScript", "wrongMode"])(
    "rejects %s lifecycle evidence",
    (failure) => {
      const input = scriptEvidence("npm", "run");
      if (failure === "missing") rmSync(join(directory, "package.json"));
      if (failure === "malformed") writeFileSync(join(directory, "package.json"), "{");
      if (failure === "stale") setScript("other-command");
      if (failure === "noEvent") input.env = { ...input.env, npm_lifecycle_event: undefined };
      if (failure === "noManifest") input.env = { ...input.env, npm_package_json: undefined };
      if (failure === "noScript") input.env = { ...input.env, npm_lifecycle_script: undefined };
      if (failure === "wrongMode") input.env = { ...input.env, npm_command: "install" };
      expect(resolveInvocation(target, input).launcher).toBe("packageRunner");
    },
  );
});

describe("structured and shell-safe commands", () => {
  it("quotes version ranges and caller arguments without splitting rendered strings", () => {
    const input = evidence({ npm_config_user_agent: "npm/12.2.0" });
    const command = packageCommand(
      resolveInvocation(target, input),
      target,
      "@alignfirst/docmap@>=0.12 <1",
    );
    expect(command.args).toEqual(["-y", "@alignfirst/docmap@>=0.12 <1"]);
    expect(renderCommand(command, ["a b", "$(touch nope)", "it's", ""])).toBe(
      "npx -y '@alignfirst/docmap@>=0.12 <1' 'a b' '$(touch nope)' 'it'\\''s' ''",
    );
  });

  it("uses package name rather than binary for recovery and preserves Bun without -y", () => {
    const input = evidence({ npm_config_user_agent: "npm/12.2.0" });
    input.runtime = "bun";
    const command = packageCommand(resolveInvocation(target, input), other, "alignfirst@~1.2.3");
    expect(command.args).toEqual(["--bun", "alignfirst@~1.2.3"]);
    expect(command.base).toBe("bunx --bun 'alignfirst@~1.2.3'");
    const direct = resolveInvocation(target, evidence({}));
    expect(packageCommand(direct, target, "@alignfirst/docmap@1").base).toBe(
      "npx -y @alignfirst/docmap@1",
    );
  });

  it("preserves exact executable paths including bunx.exe", () => {
    const command = createCommand("/tmp/Bun install/bunx.exe", ["/tmp/my file.mjs"]);
    expect(command.executable).toBe("/tmp/Bun install/bunx.exe");
    expect(command.args).toEqual(["/tmp/my file.mjs"]);
  });

  it("renders configured scripts with explicit Bun runtime", () => {
    expect(scriptCommand("npm", "workspace", { runtime: "bun" }).base).toBe(
      "bun --bun run workspace",
    );
  });
});

function evidence(env: LaunchEvidence["env"]): LaunchEvidence {
  return {
    runtime: "node",
    env,
    cwd: directory,
    entryPoint: join(directory, "entry.mjs"),
    executable: process.execPath,
  };
}

function scriptEvidence(manager: string, mode: string | undefined): LaunchEvidence {
  return {
    ...evidence({
      npm_config_user_agent: `${manager}/1.4.4`,
      npm_command: mode,
      npm_lifecycle_event: "docs",
      npm_lifecycle_script: "docmap",
      npm_package_json: join(directory, "package.json"),
    }),
    parentArgv: manager === "npm" ? ["sh", "-c", "docmap --help"] : [manager, "run", "docs"],
  };
}

function setScript(script: string): void {
  writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { docs: script } }));
}
