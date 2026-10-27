// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Manifest expressions are literal fixtures.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeCommand } from "../src/command-executor.js";
import type { Command, WorkspaceManifest } from "../src/config.js";
import { seedFiles, type SetupContextBase } from "../src/file-entries.js";
import { adaptWorkspaceManifest } from "../src/manifest-adapter.js";
import { isProcessAlive, killProcessGroup } from "../src/process-control.js";
import {
  interpolate,
  resolveCommand,
  type ScriptContextFields,
  type ScriptPhase,
  scriptContext,
} from "../src/script-context.js";
import { resolveServers } from "../src/server-descriptor.js";

let root: string;
let base: SetupContextBase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "script-runtime-"));
  execFileSync("git", ["init", "-q", root]);
  base = {
    name: "registered-suffix",
    currentWorktree: root,
    mainWorktree: root,
    isMainWorktree: true,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("script ABI and executor", () => {
  it("limits each phase to its declared optional fields", () => {
    const fields = {
      force: true,
      verbose: true,
      ports: { web: 8200 },
      file: "out",
      status: "ready",
      servers: [],
    } satisfies ScriptContextFields;
    const phases: [ScriptPhase, string[]][] = [
      ["preSetup", ["force", "verbose"]],
      ["finalize", ["force", "verbose"]],
      ["purge", ["verbose"]],
      ["devSetup", ["force", "verbose", "ports"]],
      ["workspaceFileContent", ["file"]],
      ["workspaceFilePatch", ["file"]],
      ["runFileContent", ["ports", "file"]],
      ["runFilePatch", ["ports", "file"]],
      ["runFilesInputs", ["ports"]],
      ["start", ["ports"]],
      ["stop", ["ports"]],
      ["workspaceSummary", ["status"]],
      ["devSummary", ["ports", "servers"]],
    ];
    for (const [phase, expected] of phases) {
      const context = scriptContext(base, phase, fields);
      expect(
        Object.keys(context)
          .filter((key) => Object.hasOwn(fields, key))
          .sort(),
      ).toEqual(expected.sort());
    }
  });
  it("passes literal argv, nested cwd/env and authoritative phase fields without mutating the parent", async () => {
    mkdirSync(join(root, "package"));
    vi.stubEnv("ALIGNFIRST_FORCE", "stale");
    vi.stubEnv("ALIGNFIRST_CONTEXT", "stale");
    vi.stubEnv("ALIGNFIRST_VERBOSE", "stale");
    const ctx = scriptContext(base, "start", {
      ports: JSON.parse('{"__proto__":8200,"fo-api":8201}'),
    });
    const command = resolveCommand(
      {
        run: [
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env}))",
          "a; $(touch injected)",
          "${{ ports.fo-api }}",
        ],
        cwd: "package",
        env: JSON.parse('{"VALUE":"${{ name }}","__proto__":"literal env key"}'),
      },
      ctx,
      "test",
    );
    const output = JSON.parse(await executeCommand(command, { label: "test" }));
    expect(output.args).toEqual(["a; $(touch injected)", "8201"]);
    expect(output.cwd).toBe(join(root, "package"));
    expect(output.env.VALUE).toBe(base.name);
    expect(output.env.ALIGNFIRST_FORCE).toBeUndefined();
    expect(output.env.ALIGNFIRST_VERBOSE).toBeUndefined();
    expect(Object.hasOwn(output.env, "__proto__")).toBe(true);
    expect(Reflect.get(output.env, "__proto__")).toBe("literal env key");
    expect(output.env.ALIGNFIRST_NAME).toBe(base.name);
    expect(output.env.ALIGNFIRST_IS_MAIN_WORKTREE).toBe("true");
    expect(JSON.parse(output.env.ALIGNFIRST_CONTEXT)).toEqual(ctx);
    expect(Object.getOwnPropertyDescriptor(ctx.ports, "__proto__")?.value).toBe(8200);
    expect(process.env.ALIGNFIRST_CONTEXT).toBe("stale");
    expect(existsSync(join(root, "package/injected"))).toBe(false);
  });

  it("does not template shell source or recursively expand lookup values", async () => {
    const ctx = scriptContext({ ...base, name: "${{ unavailable }}" }, "preSetup", {
      force: true,
      verbose: true,
    });
    const run = "printf '%s|%s|%s' '${{ unknown }}' \"$ALIGNFIRST_NAME\" \"$ALIGNFIRST_FORCE\"";
    expect(await executeCommand(resolveCommand({ run }, ctx, "shell"), { label: "shell" })).toBe(
      "${{ unknown }}|${{ unavailable }}|true",
    );
    expect(interpolate("${{ name }}", ctx, "inline")).toBe("${{ unavailable }}");
  });

  it("rejects unavailable references, reserved env, invalid names and NUL before launch", () => {
    const ctx = scriptContext(base, "preSetup");
    const invalid: Command[] = [
      { run: ["touch", "${{ ports.web }}"] },
      { run: ["touch", "${{ constructor }}"] },
      { run: ["touch", "${{ branch.name }}"] },
      { run: ["touch"], env: { ALIGNFIRST_NAME: "override" } },
      { run: ["touch"], env: { "bad-name": "value" } },
      { run: ["touch"], env: { VALUE: "\0" } },
    ];
    for (const command of invalid)
      expect(() => resolveCommand(command, ctx, "config.field")).toThrow(/config.field/);
    expect(() => interpolate("${{ ports.web }}", ctx, "field")).toThrow(/preSetup/);
  });

  it("keeps transformation stdout as data and propagates launch, exit and signal failures", async () => {
    const ctx = scriptContext(base, "workspaceFilePatch", { file: "out" });
    const run = (command: Command, stdin?: string) =>
      executeCommand(resolveCommand(command, ctx, "transform"), { label: "transform", stdin });
    expect(
      await run(
        { run: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"] },
        "$(touch injected)\n",
      ),
    ).toBe("$(touch injected)\n");
    expect(existsSync(join(root, "injected"))).toBe(false);
    await expect(run({ run: [join(root, "missing")] })).rejects.toThrow(/launch/);
    await expect(run({ run: "exit 7" })).rejects.toThrow(/code 7/);
    await expect(run({ run: "kill -TERM $$" })).rejects.toThrow(/SIGTERM/);
  });

  it("cancels real child/grandchild processes before any later step can launch", async () => {
    const controller = new AbortController();
    const pids = join(root, "pids.json");
    writeFileSync(
      join(root, "child.cjs"),
      `
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
child.once('spawn', () => fs.writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid])));
setInterval(() => {}, 1000);
`,
    );
    const adapters = adaptWorkspaceManifest(
      {
        schemaVersion: 1,
        workspace: {
          preSetup: [
            { name: "owned tree", run: [process.execPath, "child.cjs", pids] },
            {
              name: "must not run",
              run: [process.execPath, "-e", "require('fs').writeFileSync('later', '')"],
            },
          ],
        },
      },
      { mainWorktree: root, signal: controller.signal },
    );
    const task = adapters.workspace.preSetup?.({
      ...base,
      force: false,
      verbose: false,
      log: () => {},
    });
    const settled = Promise.resolve(task).then(
      () => undefined,
      (error: unknown) => error,
    );
    let owned: number[] = [];
    try {
      await vi.waitFor(() => expect(existsSync(pids)).toBe(true));
      owned = JSON.parse(readFileSync(pids, "utf8"));
      controller.abort();
      expect(await settled).toBeInstanceOf(Error);
      await vi.waitFor(() => {
        for (const pid of owned) expect(isRunning(pid)).toBe(false);
      });
      expect(existsSync(join(root, "later"))).toBe(false);
    } finally {
      controller.abort();
      await settled;
      for (const pid of owned) killProcessGroup(pid, "SIGKILL");
    }
  }, 10_000);
});

describe("manifest adapters", () => {
  it("awaits transforms twice, preserves local edits and rejects canonical aliases across file lists", async () => {
    const manifest: WorkspaceManifest = {
      schemaVersion: 1,
      workspace: {
        gitignoredFiles: [
          {
            path: "out.env",
            source: { kind: "content", content: "KEEP=custom\nNAME=old\n" },
            patch: {
              command: {
                run: [
                  process.execPath,
                  "-e",
                  "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s.replace(/^NAME=.*$/m,'NAME='+process.env.ALIGNFIRST_NAME)))",
                ],
              },
            },
          },
        ],
      },
    };
    const adapters = adaptWorkspaceManifest(manifest, { mainWorktree: root });
    await seedFiles({
      entries: adapters.workspace.gitignoredFiles,
      ctx: base,
      existing: "patch",
      log: { tee: () => {}, verbose: () => {} },
    });
    expect(readFileSync(join(root, "out.env"), "utf8")).toBe(
      "KEEP=custom\nNAME=registered-suffix\n",
    );
    mkdirSync(join(root, "nested"));
    symlinkSync("nested", join(root, "alias"));
    const aliases = adaptWorkspaceManifest(
      {
        schemaVersion: 1,
        workspace: {
          gitignoredFiles: [{ path: "nested/out", source: { kind: "content", content: "first" } }],
        },
        devServer: {
          servers: [],
          runFiles: [{ path: "alias/out", source: { kind: "content", content: "second" } }],
        },
      },
      { mainWorktree: root },
    );
    await expect(
      seedFiles({
        entries: aliases.workspace.gitignoredFiles,
        ctx: base,
        existing: "patch",
        log: { tee: () => {}, verbose: () => {} },
      }),
    ).rejects.toThrow(/Overlapping/);
    expect(existsSync(join(root, "nested/out"))).toBe(false);
  });

  it("reports finalize progress and uses target identity, while orphan purge executes from main", async () => {
    const progress: string[] = [];
    const adapters = adaptWorkspaceManifest(
      {
        schemaVersion: 1,
        workspace: {
          finalize: [
            { name: "install", run: "printf '%s' \"$ALIGNFIRST_CONTEXT\" > context.json" },
            { name: "build", run: "test -f context.json" },
          ],
          summary: { command: { run: "printf '%s:%s' \"$ALIGNFIRST_NAME\" pending" } },
          purge: [
            {
              name: "clean",
              run: "pwd > purge-cwd; printf '%s' \"$ALIGNFIRST_CONTEXT\" > purge-context.json",
            },
          ],
        },
      },
      { mainWorktree: root },
    );
    if (!adapters.workspace.finalizeWorkspace) throw new Error("Missing finalizer");
    await adapters.workspace.finalizeWorkspace({
      ...base,
      branch: "(detached)",
      force: true,
      verbose: true,
      progress: (label) => progress.push(label),
    });
    expect(progress).toEqual(["install", "build"]);
    expect(JSON.parse(readFileSync(join(root, "context.json"), "utf8"))).toMatchObject({
      name: base.name,
      force: true,
      verbose: true,
      phase: "finalize",
    });
    const stdout = vi.spyOn(process.stdout, "write");
    expect(
      await adapters.workspace.formatSummary({ ...base, branch: "(detached)", status: "pending" }),
    ).toBe(`${base.name}:pending`);
    expect(stdout).not.toHaveBeenCalled();
    await adapters.workspace.purgeInfrastructure?.({
      name: base.name,
      worktree: join(root, "missing"),
      recipe: { kind: "defaults" },
      mainWorktree: root,
      verbose: true,
    });
    const purge = JSON.parse(readFileSync(join(root, "purge-context.json"), "utf8"));
    expect(purge.currentWorktree).toBe(join(root, "missing"));
    expect(purge.branch).toBeUndefined();
    expect(purge.force).toBeUndefined();
    expect(readFileSync(join(root, "purge-cwd"), "utf8").trim()).toBe(root);
  });

  it("continues requested purge attempts but throws an aggregate, and command stop may be omitted", async () => {
    const adapters = adaptWorkspaceManifest(
      {
        schemaVersion: 1,
        workspace: {
          purge: [
            { name: "fails", run: "exit 3", continueOnError: true },
            { name: "later", run: "touch attempted" },
          ],
        },
        devServer: { servers: [{ kind: "command", name: "database", start: { run: "true" } }] },
      },
      { mainWorktree: root },
    );
    await expect(
      adapters.workspace.purgeInfrastructure?.({
        name: base.name,
        worktree: root,
        recipe: { kind: "defaults" },
        mainWorktree: root,
        verbose: false,
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(existsSync(join(root, "attempted"))).toBe(true);
    const server = adapters.devServer?.servers[0];
    if (server?.kind !== "callback") throw new Error("Missing command adapter");
    await server.stop({ name: base.name, cwd: root, ports: {} });
  });

  it("selects defined invocation inputs and uses the parent environment only as a default", async () => {
    const key = "SIDE32_SCRIPT_INPUT";
    vi.stubEnv(key, "parent-only");
    const manifest: WorkspaceManifest = {
      schemaVersion: 1,
      devServer: { servers: [], runFilesInputs: [key] },
    };
    const context = { ...base, ports: {} };
    const inherited = adaptWorkspaceManifest(manifest, { mainWorktree: root });
    expect(await inherited.devServer?.runFilesInputs?.(context)).toEqual({ [key]: "parent-only" });
    const env: NodeJS.ProcessEnv = { [key]: "" };
    const invocation = adaptWorkspaceManifest(manifest, { mainWorktree: root, env });
    expect(await invocation.devServer?.runFilesInputs?.(context)).toEqual({ [key]: "" });
    env[key] = undefined;
    expect(await invocation.devServer?.runFilesInputs?.(context)).toEqual({});
    delete env[key];
    expect(await invocation.devServer?.runFilesInputs?.(context)).toEqual({});
  });

  it.each(["[]", '{"host":3}', "not json"])(
    "rejects malformed computed inputs: %s",
    async (output) => {
      const adapters = adaptWorkspaceManifest(
        {
          schemaVersion: 1,
          devServer: {
            servers: [],
            runFilesInputs: {
              command: {
                run: [process.execPath, "-e", "process.stdout.write(process.argv[1])", output],
              },
            },
          },
        },
        { mainWorktree: root },
      );
      await expect(adapters.devServer?.runFilesInputs?.({ ...base, ports: {} })).rejects.toThrow(
        /JSON object of strings/,
      );
    },
  );

  it("resolves spawn cwd/env/ports after setup, disables implicit JS errors, and summarizes actual results", async () => {
    const adapters = adaptWorkspaceManifest(
      {
        schemaVersion: 1,
        devServer: {
          servers: [
            {
              kind: "spawn",
              name: "api/name",
              port: "fo-api",
              ready: { log: "READY" },
              exec: {
                run: [process.execPath, "-e", ""],
                cwd: "packages/api",
                env: { PORT: "${{ ports.fo-api }}" },
              },
            },
          ],
          summary: { command: { run: "printf '%s' \"$ALIGNFIRST_CONTEXT\"" } },
        },
      },
      { mainWorktree: root },
    );
    const dev = adapters.devServer;
    if (!dev) throw new Error("Missing dev adapter");
    const [server] = resolveServers(dev.servers, {
      name: base.name,
      cwd: root,
      ports: { "fo-api": 8201 },
    });
    if (server?.kind !== "spawn") throw new Error("Missing spawn adapter");
    expect(server.port).toBe(8201);
    expect(server.exec.cwd).toBe(join(root, "packages/api"));
    expect(server.exec.env.PORT).toBe("8201");
    expect(server.detectError).toBeUndefined();
    expect(server.detectReady("READY")).toBe(true);
    expect(server.detectReady("READY")).toBe(true);
    const summary = JSON.parse(
      (await dev.formatSummary?.({
        workspace: { name: base.name, worktree: root },
        ports: { "fo-api": 8201 },
        servers: [
          { server, port: 8201, pid: 123, logFile: join(root, ".local-wt/logs/api%2Fname.log") },
        ],
      })) ?? "null",
    );
    expect(summary).toMatchObject({
      name: base.name,
      currentWorktree: root,
      phase: "devSummary",
      ports: { "fo-api": 8201 },
      servers: [
        {
          name: "api/name",
          kind: "spawn",
          port: 8201,
          pid: 123,
          logFile: join(root, ".local-wt/logs/api%2Fname.log"),
        },
      ],
    });
    expect(summary.force).toBeUndefined();
  });
});

function isRunning(pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}
