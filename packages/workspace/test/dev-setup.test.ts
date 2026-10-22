import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeDevServers } from "../src/dev-servers-registry.js";
import { type DevSetupInput, runDevSetup } from "../src/dev-setup.js";
import {
  findWorkspaceByPath,
  readWorkspaces,
  registerWorkspace,
  registryDirFor,
  updateWorkspaces,
} from "../src/workspaces.js";

let root: string;
let input: DevSetupInput;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dev-setup-"));
  const mainWorktree = join(root, "main");
  mkdirSync(mainWorktree);
  input = {
    worktree: { currentWorktree: mainWorktree, mainWorktree, isMainWorktree: true },
    registryDir: registryDirFor(".wt"),
    runtimeDir: ".wt",
    runFiles: [],
    options: { force: false, resetPorts: false, fromFinalize: false, beforeStart: true },
  };
  vi.spyOn(process, "cwd").mockImplementation(() => input.worktree.currentWorktree);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("run-file write batches", () => {
  it.each(["changed inputs", "explicit setup with the same inputs"])(
    "reconciles after a partial failure during %s",
    async (scenario) => {
      let host = "A";
      let fail = false;
      input.runFilesInputs = () => ({ host });
      input.runFiles = [
        {
          path: "host.env",
          source: { kind: "content", content: "" },
          patch: () => `HOST=${host}\n`,
        },
        {
          path: "later.env",
          source: { kind: "content", content: "later\n" },
          patch: (content) => {
            expect(currentEntry().runFilesWrittenWith).toBeUndefined();
            if (fail) throw new Error("later patch failed");
            return content;
          },
        },
      ];
      await runDevSetup(input);
      expect(currentEntry().runFilesWrittenWith).toEqual({ ports: {}, inputs: { host: "A" } });

      if (scenario === "changed inputs") host = "B";
      else {
        input.options.beforeStart = false;
        writeFileSync(filePath("host.env"), "HOST=hand-edit\n");
      }
      fail = true;
      await expect(runDevSetup(input)).rejects.toThrow("later patch failed");
      expect(fileContent("host.env")).toBe(`HOST=${host}\n`);
      expect(currentEntry().runFilesWrittenWith).toBeUndefined();

      host = "A";
      fail = false;
      input.options.beforeStart = true;
      await runDevSetup(input);
      expect(fileContent("host.env")).toBe("HOST=A\n");
      expect(currentEntry().runFilesWrittenWith).toEqual({ ports: {}, inputs: { host: "A" } });
      expect(currentEntry().devSetupFailure).toBeUndefined();
    },
  );

  it("generates dependent content in order on creation and rewrite, with one update message", async () => {
    let host = "A";
    let generations = 0;
    input.runFilesInputs = () => ({ host });
    input.runFiles = [
      {
        path: "host.env",
        source: { kind: "content", content: "" },
        patch: () => `HOST=${host}\n`,
      },
      {
        path: "derived.txt",
        source: {
          kind: "content",
          content: async () => {
            ++generations;
            return fileContent("host.env");
          },
        },
      },
    ];
    await runDevSetup(input);
    expect(fileContent("derived.txt")).toBe("HOST=A\n");

    host = "B";
    await runDevSetup(input);
    expect(fileContent("derived.txt")).toBe("HOST=B\n");
    expect(generations).toBe(2);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "Warning: the run-file inputs changed (host). Updated host.env, derived.txt.",
    );

    writeFileSync(filePath("derived.txt"), "hand edit\n");
    await runDevSetup(input);
    expect(fileContent("derived.txt")).toBe("hand edit\n");
    expect(generations).toBe(2);
    expect(currentEntry().runFilesWrittenWith).toEqual({ ports: {}, inputs: { host: "B" } });
  });

  it("reports preceding updates when a later generated source fails", async () => {
    let host = "A";
    let fail = false;
    input.runFilesInputs = () => ({ host });
    input.runFiles = [
      { path: "host.env", source: { kind: "content", content: () => `HOST=${host}\n` } },
      {
        path: "later.txt",
        source: {
          kind: "content",
          content: () => {
            if (fail) throw new Error("generation failed");
            return "later\n";
          },
        },
      },
    ];
    await runDevSetup(input);
    host = "B";
    fail = true;
    await expect(runDevSetup(input)).rejects.toThrow("generation failed");
    expect(fileContent("host.env")).toBe("HOST=B\n");
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "Warning: the run-file inputs changed (host). Updated host.env.",
    );
    expect(currentEntry().runFilesWrittenWith).toBeUndefined();
  });

  it("updates run files before provisioning infrastructure after a main-directory rename", async () => {
    const provisioned: string[] = [];
    input.runFiles = [
      {
        path: "container.env",
        source: { kind: "content", content: "" },
        patch: (_content, ctx) => `CONTAINER=${ctx.name}-database\n`,
      },
    ];
    input.setup = (ctx) => {
      expect(fileContent("container.env")).toBe(`CONTAINER=${ctx.name}-database\n`);
      provisioned.push(ctx.name);
    };
    await runDevSetup(input);
    const renamed = join(root, "renamed");
    renameSync(input.worktree.mainWorktree, renamed);
    input.worktree = { currentWorktree: renamed, mainWorktree: renamed, isMainWorktree: true };

    await runDevSetup(input);
    expect(fileContent("container.env")).toBe("CONTAINER=renamed-database\n");
    expect(provisioned).toEqual(["main", "renamed"]);
    expect(currentEntry().runFilesWrittenWith).toEqual({ ports: {}, inputs: {} });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "Warning: the run files had no recorded ports or inputs. Updated container.env.",
    );
  });
});

describe("registered main identity", () => {
  it("shares allocation with registration and preserves a suffix, ports and setup state", async () => {
    const { mainWorktree } = input.worktree;
    await registerWorkspace({
      currentWorktree: "/external/main",
      mainWorktree,
      registryDir: input.registryDir,
      isMainWorktree: false,
    });
    const provisioned: string[] = [];
    input.setup = (ctx) => {
      provisioned.push(ctx.name);
    };
    input.runFiles = [
      { path: "name.env", source: { kind: "content", content: (ctx) => ctx.name } },
    ];
    const first = await runDevSetup(input);
    expect(first.workspace.name).toMatch(/^main-[a-f0-9]{8}$/);
    expect(currentEntry().neverFinalized).toBe(true);
    await updateWorkspaces(mainWorktree, input.registryDir, (registry) => {
      delete registry.workspaces.main;
      registry.workspaces[first.workspace.name].ports = { web: 8200 };
    });
    const moved = join(root, "elsewhere", "main");
    mkdirSync(join(root, "elsewhere"));
    renameSync(mainWorktree, moved);
    input.worktree = { currentWorktree: moved, mainWorktree: moved, isMainWorktree: true };
    const second = await runDevSetup(input);
    expect(second.workspace.name).toBe(first.workspace.name);
    expect(second.ports).toEqual({ web: 8200 });
    expect(provisioned).toEqual([first.workspace.name]);
    expect(fileContent("name.env")).toBe(first.workspace.name);
    const registered = await registerWorkspace({
      ...input.worktree,
      registryDir: input.registryDir,
    });
    expect(registered).toEqual({ name: first.workspace.name, status: "pending" });
    expect(currentEntry().neverFinalized).toBeUndefined();
  });

  it("checks the detected root for reset-ports even when invoked from a nested directory", async () => {
    await runDevSetup(input);
    const { mainWorktree } = input.worktree;
    mkdirSync(join(mainWorktree, "nested"));
    vi.mocked(process.cwd).mockReturnValue(join(mainWorktree, "nested"));
    writeDevServers(mainWorktree, input.registryDir, {
      servers: [
        {
          name: "main",
          worktree: mainWorktree,
          pids: { web: process.pid },
          startedAt: new Date().toISOString(),
        },
      ],
    });
    input.options.resetPorts = true;
    await expect(runDevSetup(input)).rejects.toThrow("dev-server of this worktree is running");
  });
});

function currentEntry() {
  const { mainWorktree, currentWorktree } = input.worktree;
  const found = findWorkspaceByPath(
    readWorkspaces(mainWorktree, input.registryDir),
    currentWorktree,
  );
  if (!found) throw new Error("No current entry");
  return found.entry;
}

function fileContent(path: string): string {
  return readFileSync(filePath(path), "utf-8");
}

function filePath(path: string): string {
  return join(input.worktree.currentWorktree, path);
}
