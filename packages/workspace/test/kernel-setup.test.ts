import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceError } from "../src/errors.js";
import type { GitignoredFileEntry, GitignoredFileSource } from "../src/file-entries.js";
import { readWorkspaceInventory } from "../src/inventory.js";
import type { FinalizeContext } from "../src/workspace.js";
import { updateWorkspaces } from "../src/workspaces.js";
import {
  addWorktree,
  commit,
  createKernelFixture,
  finalize,
  type KernelFixture,
  registryDir,
  removeKernelFixtures,
  requiredEntry,
  runKernel,
} from "./kernel-fixture.js";

afterEach(removeKernelFixtures);

describe("setup preparation", () => {
  it("keeps earlier file writes and the ready state when a later patch fails", async () => {
    const fx = createKernelFixture();
    let fail = false;
    fx.config.gitignoredFiles = [
      linkedMarkerEntry("workspace.local", { kind: "content", content: "" }),
      {
        path: "required.local",
        source: { kind: "content", content: "" },
        patch: (content) => {
          if (fail) throw new Error("required source missing");
          return content;
        },
      },
    ];
    ignore(fx, ["workspace.local", "required.local"]);
    await runKernel(fx, ["setup"]);
    writeFileSync(join(fx.repo, "workspace.local"), "edited-by-hand\n");
    writeFileSync(join(fx.repo, "required.local"), "preserve-on-failure\n");
    fail = true;
    await expect(runKernel(fx, ["setup"])).rejects.toThrow("required source missing");
    expect(readFileSync(join(fx.repo, "workspace.local"), "utf8")).toBe(
      "edited-by-hand\nworktree=main\n",
    );
    expect(readFileSync(join(fx.repo, "required.local"), "utf8")).toBe("preserve-on-failure\n");
    const { entry } = requiredEntry(fx, fx.repo);
    expect(entry.status).toBe("ready");
    expect(entry.preparationOwner).toBeUndefined();
  });
});

describe("same-basename linked worktrees", () => {
  it("seeds and links across parents, and finalizes each with its registered identity", async () => {
    const fx = sameBasenameFixture();
    const contexts = recordFinalizations(fx);
    writeFileSync(join(fx.repo, "workspace.local"), "customized-main\n");
    for (const worktree of [fx.first, fx.second]) await setupAndFinalize(fx, worktree);
    const one = requiredEntry(fx, fx.first);
    const two = requiredEntry(fx, fx.second);
    expect(one.name).toBe("same");
    expect(two.name).toMatch(/^same-[a-f0-9]{8}$/);
    expect(contexts).toEqual([
      finalizeContext(fx, fx.first, one.name, "external-one"),
      finalizeContext(fx, fx.second, two.name, "external-two"),
    ]);
    for (const worktree of [fx.first, fx.second]) {
      expect(requiredEntry(fx, worktree).entry.status).toBe("ready");
      expect(readFileSync(join(worktree, "workspace.local"), "utf8")).toBe(
        "customized-main\nworktree=linked\n",
      );
      expect(realpathSync(join(worktree, ".shared"))).toBe(join(fx.repo, ".shared"));
      expect(realpathSync(join(worktree, ".local-wt/workspace-registry"))).toBe(registryDir(fx));
    }
    expect(readFileSync(join(fx.repo, "workspace.local"), "utf8")).toBe("customized-main\n");
    await runKernel(fx, ["status", two.name]);
    await expect(runKernel(fx, ["status", join(fx.root, "unknown/same")])).rejects.toThrow(
      WorkspaceError,
    );
  });

  it("records suffixed finalize and pre-finalize failures and retries the same identity", async () => {
    const fx = sameBasenameFixture();
    let failure: "finalize" | "seed" | undefined;
    fx.config.finalizeWorkspace = () => {
      if (failure === "finalize") throw new Error("finalize failed");
    };
    fx.config.gitignoredFiles = [
      {
        path: "required.local",
        source: { kind: "content", content: "" },
        patch: (content) => {
          if (failure === "seed") throw new Error("seed failed");
          return content;
        },
      },
    ];
    await setupAndFinalize(fx, fx.first);
    const original = requiredEntry(fx, fx.first).entry;
    failure = "finalize";
    await expect(setupAndFinalize(fx, fx.second)).rejects.toThrow("finalize failed");
    const { name } = requiredEntry(fx, fx.second);
    expect(requiredEntry(fx, fx.second).entry).toMatchObject({
      status: "failed",
      failure: expect.anything(),
    });
    failure = "seed";
    await expect(runKernel(fx, ["setup", "-d"], { cwd: fx.second })).rejects.toThrow("seed failed");
    expect(requiredEntry(fx, fx.second).entry).toMatchObject({
      status: "failed",
      failure: expect.anything(),
    });
    failure = undefined;
    await setupAndFinalize(fx, fx.second);
    expect(requiredEntry(fx, fx.second).name).toBe(name);
    expect(requiredEntry(fx, fx.second).entry.failure).toBeUndefined();
    expect(requiredEntry(fx, fx.first).entry).toEqual(original);
  });
});

describe("inventory", () => {
  it("reports allocated ports and an empty map for a workspace without ports", async () => {
    const fx = createKernelFixture();
    const linked = addWorktree(fx, "linked", "linked");
    await runKernel(fx, ["setup"]);
    await runKernel(fx, ["setup"], { cwd: linked });
    await updateWorkspaces(fx.repo, registryDir(fx), (registry) => {
      registry.workspaces.app.ports = { web: 47_100, api: 47_102 };
    });
    const inventory = readWorkspaceInventory({ cwd: fx.repo, env: fx.env }, registryDir(fx));
    expect(inventory.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: fx.repo, ports: { web: 47_100, api: 47_102 } }),
        expect.objectContaining({ path: linked, ports: {} }),
      ]),
    );
  });
});

interface SameBasenameFixture extends KernelFixture {
  first: string;
  second: string;
}

function sameBasenameFixture(): SameBasenameFixture {
  const fx = createKernelFixture();
  mkdirSync(join(fx.repo, ".shared"));
  ignore(fx, [".shared", "workspace.local", "required.local"]);
  commit(fx.repo);
  fx.config.sharedDirs = [".shared"];
  fx.config.gitignoredFiles = [linkedMarkerEntry("workspace.local")];
  return Object.assign(fx, {
    first: addWorktree(fx, "managed/one/same", "external-one"),
    second: addWorktree(fx, "external/nested/two/same", "external-two"),
  });
}

/** Seeds from main and appends a line naming the worktree kind; idempotent. */
function linkedMarkerEntry(
  path: string,
  source: GitignoredFileSource = { kind: "mainWorktree" },
): GitignoredFileEntry {
  return {
    path,
    source,
    patch: (content, ctx) =>
      `${content
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("worktree="))
        .concat(`worktree=${ctx.isMainWorktree ? "main" : "linked"}`)
        .join("\n")}\n`,
  };
}

function ignore(fx: KernelFixture, paths: string[]): void {
  writeFileSync(
    join(fx.repo, ".gitignore"),
    `/.plans\n/.local-wt/\n${paths.map((path) => `/${path}`).join("\n")}\n`,
  );
}

function recordFinalizations(fx: KernelFixture): object[] {
  const contexts: object[] = [];
  fx.config.finalizeWorkspace = (ctx: FinalizeContext) => {
    const { name, currentWorktree, mainWorktree, isMainWorktree, branch } = ctx;
    contexts.push({ name, currentWorktree, mainWorktree, isMainWorktree, branch });
  };
  return contexts;
}

function finalizeContext(
  fx: KernelFixture,
  worktree: string,
  name: string,
  branch: string,
): object {
  return { name, currentWorktree: worktree, mainWorktree: fx.repo, isMainWorktree: false, branch };
}

async function setupAndFinalize(fx: KernelFixture, worktree: string): Promise<void> {
  await runKernel(fx, ["setup", "-d"], { cwd: worktree });
  await finalize(fx, worktree);
}
