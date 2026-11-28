import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkspaceStorage } from "../src/storage.js";
import { readWorkspaces } from "../src/workspaces.js";
import {
  addWorktree,
  commit,
  createKernelFixture,
  entryAt,
  git,
  type KernelFixture,
  registryDir,
  removeKernelFixtures,
  runKernel,
} from "./kernel-fixture.js";

afterEach(removeKernelFixtures);

describe("preparation before mutable setup", () => {
  it("publishes the recipe and external cleanup identity before a failing preSetup", async () => {
    const fx = createKernelFixture();
    const storage = resolveWorkspaceStorage(
      { in: "companion", mainWorktree: fx.repo, companionDir: join(fx.root, "companion") },
      fx.repo,
    );
    fx.config = {
      ...fx.config,
      recipe: { kind: "manifest", file: "alignfirst.json", in: "project" },
      storage,
      preSetup: () => {
        throw new Error("mutable preparation failed");
      },
    };
    const target = targetPath(fx);
    await expect(runKernel(fx, ["setup", "-c", "failure", "--path", target])).rejects.toThrow();
    const state = readWorkspaces(fx.repo, storage.registryDir);
    expect(Object.values(state.workspaces)).toMatchObject([
      { status: "failed", recipe: { kind: "manifest", in: "project" } },
    ]);
    expect(Object.values(state.workspaces)[0].preparationOwner).toBeUndefined();
    expect(Object.values(state.runtimeOwners ?? {})).toMatchObject([
      { worktree: target, state: "active" },
    ]);
    await runKernel(fx, ["teardown", target]);
    expect(fx.purges).toMatchObject([{ worktree: target }]);
  });

  it("prepares an unborn main worktree, preserving its index, and refuses linked setup until a commit exists", async () => {
    const fx = createKernelFixture({ unborn: true });
    git(fx.repo, "add", "README.md");
    const index = readFileSync(join(fx.repo, ".git/index"));
    expect(await runKernel(fx, ["setup"])).toMatchObject({ worktree: fx.repo, status: "ready" });
    expect(readFileSync(join(fx.repo, ".git/index"))).toEqual(index);
    expect(git(fx.repo, "rev-list", "--all")).toBe("");
    const target = targetPath(fx);
    await expect(runKernel(fx, ["setup", "-c", "topic", "--path", target])).rejects.toThrow("HEAD");
    expect(existsSync(target)).toBe(false);
    commit(fx.repo);
    expect(await runKernel(fx, ["setup", "-c", "topic", "--path", target])).toMatchObject({
      worktree: target,
      status: "ready",
    });
  });

  it("refuses a staged .local-wt in an unborn repository without changing its index or files", async () => {
    const fx = createKernelFixture({ unborn: true });
    mkdirSync(join(fx.repo, ".local-wt"));
    writeFileSync(join(fx.repo, ".local-wt/keep"), "staged bytes");
    git(fx.repo, "add", "-f", ".local-wt");
    const index = readFileSync(join(fx.repo, ".git/index"));
    await expect(runKernel(fx, ["setup"])).rejects.toThrow();
    expect(readFileSync(join(fx.repo, ".git/index"))).toEqual(index);
    expect(readFileSync(join(fx.repo, ".local-wt/keep"), "utf8")).toBe("staged bytes");
    expect(existsSync(join(registryDir(fx), "workspaces.json"))).toBe(false);
  });

  it.each([
    "unignoredRuntime",
    "runtimeLink",
    "runtimeLogsLink",
    "runtimeLogFileLink",
    "oldRegistry",
    "targetPlans",
    "targetRuntime",
  ])("refuses %s before branch, destination or log writes", async (kind) => {
    const fx = createKernelFixture();
    const local = join(fx.repo, ".local-wt");
    if (kind === "unignoredRuntime") {
      writeFileSync(join(fx.repo, ".gitignore"), "/.plans\n");
      commit(fx.repo);
    }
    if (kind === "runtimeLink") symlinkSync(fx.root, local);
    if (kind === "runtimeLogsLink") {
      mkdirSync(local);
      symlinkSync(fx.root, join(local, "logs"));
    }
    if (kind === "runtimeLogFileLink") {
      mkdirSync(join(local, "logs"), { recursive: true });
      symlinkSync(join(fx.repo, "README.md"), join(local, "logs/workspace-setup.log"));
    }
    if (kind === "oldRegistry") {
      mkdirSync(registryDir(fx), { recursive: true });
      writeFileSync(
        join(registryDir(fx), "workspaces.json"),
        JSON.stringify({ version: 3, workspaces: {} }),
      );
    }
    let from: string[] = [];
    if (kind === "targetPlans" || kind === "targetRuntime") {
      const path = kind === "targetPlans" ? ".plans/keep" : ".local-wt/keep";
      mkdirSync(join(fx.repo, path, ".."), { recursive: true });
      writeFileSync(join(fx.repo, path), "target bytes");
      git(fx.repo, "add", "-f", path);
      commit(fx.repo);
      git(fx.repo, "branch", "target-base");
      git(fx.repo, "rm", "--quiet", "--cached", path);
      commit(fx.repo);
      from = ["--from", "target-base"];
    }
    const target = targetPath(fx);
    await expect(
      runKernel(fx, ["setup", "-c", "topic", "--path", target, ...from]),
    ).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
    expect(git(fx.repo, "branch", "--list", "topic")).toBe("");
    if (kind !== "runtimeLogsLink" && kind !== "runtimeLogFileLink")
      expect(existsSync(join(local, "logs"))).toBe(false);
    expect(readFileSync(join(fx.repo, "README.md"), "utf8")).toBe("project\n");
  });

  it.each(["occupied", "existing", "dangling", "inside", "ambiguousRemote"])(
    "refuses %s intent without a partial branch",
    async (kind) => {
      const fx = createKernelFixture();
      let path = targetPath(fx);
      let args = ["-c", "topic"];
      if (kind === "occupied") args = ["main"];
      if (kind === "existing") mkdirSync(path);
      if (kind === "dangling") symlinkSync(join(fx.root, "missing"), path);
      if (kind === "inside") path = join(fx.repo, "nested");
      if (kind === "ambiguousRemote") {
        for (const remote of ["one", "two"])
          git(fx.repo, "update-ref", `refs/remotes/${remote}/topic`, "HEAD");
        args = ["topic"];
      }
      await expect(runKernel(fx, ["setup", ...args, "--path", path])).rejects.toThrow();
      expect(git(fx.repo, "branch", "--list", "topic")).toBe("");
    },
  );

  it("reuses local and unambiguous fetched remote branches without fetching", async () => {
    const fx = createKernelFixture();
    git(fx.repo, "branch", "local");
    const local = join(fx.root, "local");
    await runKernel(fx, ["setup", "local", "--path", local]);
    expect(git(local, "symbolic-ref", "--short", "HEAD").trim()).toBe("local");
    git(fx.repo, "config", "remote.origin.url", "/unreachable");
    git(fx.repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git(fx.repo, "update-ref", "refs/remotes/origin/fetched", "HEAD");
    git(fx.repo, "config", "branch.autoSetupMerge", "false");
    const target = targetPath(fx);
    expect(await runKernel(fx, ["setup", "fetched", "--path", target])).toMatchObject({
      worktree: target,
      status: "ready",
    });
    expect(git(target, "symbolic-ref", "--short", "HEAD").trim()).toBe("fetched");
    expect(git(fx.repo, "config", "branch.fetched.remote").trim()).toBe("origin");
    expect(git(fx.repo, "config", "branch.fetched.merge").trim()).toBe("refs/heads/fetched");
  });
});

describe("adoption of existing worktrees", () => {
  it.each(["detached", "relative", "locked"])(
    "adopts a %s worktree without changing branches, index or dirty bytes",
    async (kind) => {
      const fx = createKernelFixture();
      const target = targetPath(fx);
      git(
        fx.repo,
        "worktree",
        "add",
        "--quiet",
        ...(kind === "detached" ? ["--detach"] : ["-b", "topic"]),
        target,
      );
      if (kind === "locked") git(fx.repo, "worktree", "lock", target);
      mkdirSync(join(fx.repo, ".local"));
      writeFileSync(join(fx.repo, ".local/keep"), "shared");
      writeFileSync(join(target, "README.md"), "staged");
      git(target, "add", "README.md");
      writeFileSync(join(target, "README.md"), "dirty");
      const bytes = Buffer.from([0, 255, 10]);
      writeFileSync(join(target, "unrelated"), bytes);
      const index = git(
        target,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ).trim();
      const before = readFileSync(index);
      const refs = git(fx.repo, "show-ref", "--heads");
      const trees = git(fx.repo, "worktree", "list", "--porcelain", "-z");
      const outcome =
        kind === "relative"
          ? await runKernel(fx, ["setup", "--path", relative(fx.repo, target)])
          : await runKernel(fx, ["setup"], { cwd: target });
      expect(outcome).toMatchObject({ worktree: target, status: "ready" });
      expect(readFileSync(index)).toEqual(before);
      expect(readFileSync(join(target, "README.md"), "utf8")).toBe("dirty");
      expect(readFileSync(join(target, "unrelated"))).toEqual(bytes);
      expect(readFileSync(join(target, ".local/keep"), "utf8")).toBe("shared");
      expect(git(fx.repo, "show-ref", "--heads")).toBe(refs);
      expect(git(fx.repo, "worktree", "list", "--porcelain", "-z")).toBe(trees);
    },
  );

  it.each(["foreign", "subdirectory"])("rejects an explicit %s root", async (kind) => {
    const fx = createKernelFixture();
    const target = addWorktree(fx, "external target", "topic");
    let path = join(target, "nested");
    if (kind === "foreign") {
      path = join(fx.root, "foreign");
      mkdirSync(path);
      git(path, "init", "--quiet", "-b", "main");
      commit(path);
    } else mkdirSync(path);
    const before = git(fx.repo, "worktree", "list", "--porcelain", "-z");
    await expect(runKernel(fx, ["setup", "--path", path])).rejects.toThrow();
    expect(git(fx.repo, "worktree", "list", "--porcelain", "-z")).toBe(before);
    expect(existsSync(join(target, ".plans"))).toBe(false);
  });
});

describe("shared links and file destinations", () => {
  it("retains partial links after an ignore failure and retries without replacing them", async () => {
    const fx = createKernelFixture();
    const target = addWorktree(fx, "external target", "topic");
    writeFileSync(join(target, ".gitignore"), "/.local-wt/\n!/.plans\n");
    await expect(runKernel(fx, ["setup", "--path", target])).rejects.toThrow(
      `setup --path '${target}'`,
    );
    expect(realpathSync(join(target, ".plans"))).toBe(join(fx.repo, ".plans"));
    const spelling = readlinkSync(join(target, ".plans"));
    writeFileSync(join(target, ".gitignore"), "/.plans\n/.local-wt/\n");
    expect(await runKernel(fx, ["setup", "--path", target])).toMatchObject({ status: "ready" });
    expect(readlinkSync(join(target, ".plans"))).toBe(spelling);
    expect(git(target, "branch", "--show-current").trim()).toBe("topic");
  });

  it.each([
    { name: ".plans", kind: "directory" },
    { name: ".local", kind: "brokenLink" },
    { name: ".local-wt/workspace-registry", kind: "wrongLink" },
  ])(
    "preflights every link destination before applying any for a $kind at $name",
    async ({ name, kind }) => {
      const fx = createKernelFixture();
      const target = addWorktree(fx, "external target", "topic");
      mkdirSync(join(fx.repo, ".local"));
      const path = join(target, name);
      mkdirSync(join(path, ".."), { recursive: true });
      if (kind === "directory") mkdirSync(path);
      if (kind === "brokenLink") symlinkSync(join(fx.root, "missing"), path);
      if (kind === "wrongLink") symlinkSync(fx.root, path);
      const ino = lstatSync(path).ino;
      const exclude = join(fx.repo, ".git/info/exclude");
      const bytes = readFileSync(exclude);
      await expect(runKernel(fx, ["setup", "--path", target])).rejects.toThrow(path);
      expect(lstatSync(path).ino).toBe(ino);
      expect(readFileSync(exclude)).toEqual(bytes);
      if (name !== ".plans") expect(existsSync(join(target, ".plans"))).toBe(false);
    },
  );

  it.each([
    { name: ".plans", kind: "staged" },
    { name: ".local", kind: "committed" },
    { name: ".local", kind: "stagedDeletion" },
  ])("refuses tracked plans and preserves tracked .local: $kind $name", async ({ name, kind }) => {
    const fx = createKernelFixture();
    const target = addWorktree(fx, "external target", "topic");
    const path = join(target, name);
    mkdirSync(path);
    writeFileSync(join(path, "keep"), "tracked");
    git(target, "add", "-f", name);
    if (kind !== "staged") commit(target);
    if (kind === "stagedDeletion") git(target, "rm", "--quiet", "-r", name);
    const index = git(target, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
    const before = readFileSync(index);
    const setup = runKernel(fx, ["setup", "--path", target]);
    if (name === ".plans") await expect(setup).rejects.toThrow();
    else await expect(setup).resolves.toMatchObject({ status: "ready" });
    expect(readFileSync(index)).toEqual(before);
    if (kind === "stagedDeletion") expect(existsSync(path)).toBe(false);
    else expect(readFileSync(join(path, "keep"), "utf8")).toBe("tracked");
  });

  it.each([".plans/generated", ".local-wt/generated"])(
    "preflights file destination %s before applying any link",
    async (path) => {
      const fx = createKernelFixture();
      fx.config = {
        ...fx.config,
        gitignoredFiles: [{ path, source: { kind: "content", content: "never written" } }],
      };
      const target = targetPath(fx);
      await expect(runKernel(fx, ["setup", "-c", "topic", "--path", target])).rejects.toThrow();
      expect(existsSync(target)).toBe(true);
      for (const dir of [
        join(target, ".plans"),
        join(target, ".local-wt"),
        join(fx.repo, ".local-wt"),
      ])
        expect(existsSync(dir)).toBe(false);
    },
  );

  it("refuses explicit sharing of reserved runtime storage", async () => {
    const fx = createKernelFixture();
    fx.config = { ...fx.config, sharedDirs: [".local-wt/data"] };
    const target = targetPath(fx);
    await expect(runKernel(fx, ["setup", "-c", "topic", "--path", target])).rejects.toThrow();
    expect(existsSync(join(target, ".plans"))).toBe(false);
    expect(existsSync(join(fx.repo, ".local-wt/data"))).toBe(false);
  });

  it.each(["missing", "trackedAlias", "file"])(
    "handles an optional .local source %s without replacing target content",
    async (kind) => {
      const fx = createKernelFixture();
      const target = addWorktree(fx, "external target", "topic");
      const source = join(fx.repo, ".local");
      if (kind === "trackedAlias") {
        const tracked = join(fx.repo, "tracked-local");
        mkdirSync(tracked);
        writeFileSync(join(tracked, "keep"), "source");
        commit(fx.repo);
        symlinkSync(tracked, source);
      }
      if (kind === "file") writeFileSync(source, "source file");
      mkdirSync(join(target, ".local"));
      writeFileSync(join(target, ".local/keep"), "unrelated bytes");
      const setup = runKernel(fx, ["setup", "--path", target]);
      if (kind === "file") await expect(setup).rejects.toThrow(source);
      else await expect(setup).resolves.toMatchObject({ status: "ready" });
      expect(readFileSync(join(target, ".local/keep"), "utf8")).toBe("unrelated bytes");
      expect(lstatSync(join(target, ".local")).isDirectory()).toBe(true);
    },
  );

  it("shares optional .local independently of extras and follows later main-link repairs", async () => {
    const fx = createKernelFixture();
    const local = join(fx.root, "local source");
    mkdirSync(local);
    symlinkSync(local, join(fx.repo, ".local"));
    fx.config = { ...fx.config, sharedDirs: [".shared"] };
    const target = targetPath(fx);
    await runKernel(fx, ["setup", "-c", "topic", "--path", target]);
    expect(realpathSync(join(target, ".local"))).toBe(local);
    expect(realpathSync(join(target, ".shared"))).toBe(join(fx.repo, ".shared"));
    const replacement = join(fx.root, "replacement");
    mkdirSync(replacement);
    rmSync(join(fx.repo, ".local"));
    symlinkSync(replacement, join(fx.repo, ".local"));
    expect(realpathSync(join(target, ".local"))).toBe(replacement);
    expect(await runKernel(fx, ["setup", "--path", target])).toMatchObject({ status: "ready" });
  });

  it("accepts an equivalent external link without replacing its spelling and repairs exclusions idempotently", async () => {
    const fx = createKernelFixture();
    const target = addWorktree(fx, "external target", "topic");
    const workFiles = join(fx.root, "work files", "app");
    mkdirSync(workFiles, { recursive: true });
    rmSync(join(fx.repo, ".plans"), { recursive: true });
    symlinkSync(workFiles, join(fx.repo, ".plans"));
    const spelling = relative(target, workFiles);
    symlinkSync(spelling, join(target, ".plans"));
    const ino = lstatSync(join(target, ".plans")).ino;
    const exclude = join(fx.repo, ".git/info/exclude");
    writeFileSync(exclude, "# owner without newline");
    for (let iteration = 0; iteration < 2; ++iteration) {
      expect(await runKernel(fx, ["setup", "--path", target])).toMatchObject({ status: "ready" });
      expect(readlinkSync(join(target, ".plans"))).toBe(spelling);
      expect(lstatSync(join(target, ".plans")).ino).toBe(ino);
    }
    expect(readFileSync(exclude, "utf8")).toBe("# owner without newline\n/.plans\n");
  });
});

describe("protected deletion", () => {
  it("force preserves a target holding main's shared .local", async () => {
    const fx = createKernelFixture();
    const target = addWorktree(fx, "external target", "topic");
    const shared = join(target, "protected");
    mkdirSync(shared);
    writeFileSync(join(shared, "keep"), "shared bytes");
    symlinkSync(shared, join(fx.repo, ".local"));
    const registrations = git(fx.repo, "worktree", "list", "--porcelain", "-z");
    await expect(runKernel(fx, ["remove", target, "--force"])).rejects.toThrow(shared);
    expect(readFileSync(join(shared, "keep"), "utf8")).toBe("shared bytes");
    expect(git(fx.repo, "worktree", "list", "--porcelain", "-z")).toBe(registrations);
    expect(entryAt(fx, target)).toBeUndefined();
  });
});

function targetPath(fx: KernelFixture): string {
  return join(fx.root, "external target");
}
