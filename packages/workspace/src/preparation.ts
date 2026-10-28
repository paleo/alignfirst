import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
import { assertFileDestination } from "./file-destinations.js";
import {
  canonicalPath,
  git,
  headCommit,
  isInside,
  isProjectTrackedDirectory,
  pathExists,
  readRepository,
  type GitContext,
} from "./git.js";
import type { SharedDirectoryProtection, WorkspaceHost } from "./operation.js";
import { resolveWorkspaceStorage, type WorkspaceStorage } from "./storage.js";
import { assertDirectoryPath } from "./registry-ownership.js";
import type { WorktreeContext } from "./worktree.js";

export interface Preparation {
  apply: () => Promise<void>;
}

interface Link {
  path: string;
  source: string;
}

export async function validateMainBaseline(
  ctx: WorktreeContext,
  host: WorkspaceHost,
  env: NodeJS.ProcessEnv,
  storage?: WorkspaceStorage,
): Promise<SharedDirectoryProtection> {
  await host.validateWorkFiles(ctx.mainWorktree);
  const protection = await host.sharedDirectoryProtection(ctx.mainWorktree);
  const source = { cwd: ctx.mainWorktree, env };
  if (protection.plans.in === "project") assertIgnored(source, ".plans");
  validateRuntimeStorage(source, storage);
  const local = join(ctx.mainWorktree, ".local");
  if (
    pathExists(local) &&
    !targetTracks(source, preparationCommit(source), ".local") &&
    !statSync(local).isDirectory()
  )
    throw new WorkspaceError(`Source is not a usable directory: ${local}`);
  return protection;
}

function preparationCommit(source: GitContext): string | undefined {
  const head = headCommit(source);
  if (head === undefined && canonicalPath(source.cwd) !== readRepository(source).mainWorktree)
    throw new WorkspaceError(
      "HEAD has no commit. Only the main worktree can be prepared before its initial commit.",
    );
  return head;
}

export function assertReservedCommit(
  source: GitContext,
  commit: string | undefined,
  protection: SharedDirectoryProtection,
  includeIndex = false,
  storage?: WorkspaceStorage,
): void {
  for (const name of [
    ...(storage?.in === "companion" ? [] : [".local-wt"]),
    ...(protection.plans.in === "project" ? [".plans"] : []),
  ]) {
    if (targetTracks(source, commit, name, includeIndex))
      throw new WorkspaceError(
        `Target commit${includeIndex ? " or index" : ""} tracks ${name}. Untrack and ignore it before workspace setup.`,
      );
  }
}

function targetTracks(
  source: GitContext,
  commit: string | undefined,
  path: string,
  includeIndex = true,
): boolean {
  return (
    (commit !== undefined &&
      git(source, "--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", commit, "--", path)
        .length > 0) ||
    (includeIndex && git(source, "--literal-pathspecs", "ls-files", "-z", "--", path).length > 0)
  );
}

export async function planPreparation(
  ctx: WorktreeContext,
  host: WorkspaceHost,
  env: NodeJS.ProcessEnv,
  sharedDirs: string[],
  filePaths: string[],
  diagnostic: (message: string) => void,
  registryDir = join(ctx.mainWorktree, ".local-wt", "workspace-registry"),
  storage?: WorkspaceStorage,
): Promise<Preparation> {
  const protection = await host.sharedDirectoryProtection(ctx.mainWorktree);
  const source = { cwd: ctx.mainWorktree, env };
  const target = { cwd: ctx.currentWorktree, env };
  const mainCommit = preparationCommit(source);
  const targetCommit = ctx.isMainWorktree ? mainCommit : preparationCommit(target);
  assertReservedCommit(target, targetCommit, protection, true, storage);
  validateRuntimeStorage(target, storage);
  const repo = readRepository(source);
  const links: Link[] = [];
  const createSources: string[] = [];
  if (!ctx.isMainWorktree && protection.plans.in === "project")
    links.push({ path: join(ctx.currentWorktree, ".plans"), source: protection.plans.path });
  const names = new Set(sharedDirs);
  names.add(".local");
  for (const name of names) {
    const main = resolve(ctx.mainWorktree, name);
    if (
      name !== ".local" &&
      (name === "" ||
        !isInside(ctx.mainWorktree, main) ||
        main === ctx.mainWorktree ||
        [
          join(ctx.mainWorktree, ".plans"),
          storage?.in === "companion"
            ? resolve(storage.registryDir, "..")
            : join(ctx.mainWorktree, ".local-wt"),
          protection.plans.path,
          registryDir,
        ].some(
          (reserved) =>
            isInside(canonicalPath(reserved), canonicalPath(main)) ||
            isInside(canonicalPath(main), canonicalPath(reserved)),
        ))
    )
      throw new WorkspaceError(
        `Shared directory overlaps mandatory plans/runtime storage: ${name}`,
      );
    if (targetTracks(target, targetCommit, name)) {
      if (name !== ".local") throw new WorkspaceError(`Shared directory is tracked: ${name}`);
      diagnostic(
        "Warning: Target branch tracks .local; it remains branch-local and is not shared.",
      );
      continue;
    }
    if (targetTracks(source, mainCommit, name)) {
      if (name !== ".local")
        throw new WorkspaceError(`Shared source contains project-tracked content: ${main}`);
      diagnostic("Warning: Main .local contains tracked content; it is not shared.");
      continue;
    }
    if (!pathExists(main)) {
      if (name === ".local") continue;
      createSources.push(main);
      if (!ctx.isMainWorktree)
        links.push({ path: resolve(ctx.currentWorktree, name), source: main });
      continue;
    }
    const runtime =
      storage?.in === "companion"
        ? resolve(storage.registryDir, "..")
        : canonicalPath(join(ctx.mainWorktree, ".local-wt"));
    if (isInside(runtime, canonicalPath(main)) || isInside(canonicalPath(main), runtime))
      throw new WorkspaceError(`Shared directory overlaps runtime storage: ${main}`);
    if (isProjectTrackedDirectory(source, main, repo.commonDir)) {
      if (name !== ".local")
        throw new WorkspaceError(`Shared source contains project-tracked content: ${main}`);
      diagnostic("Warning: Main .local contains tracked content; it is not shared.");
      continue;
    }
    if (!statSync(main).isDirectory())
      throw new WorkspaceError(`Source is not a usable directory: ${main}`);
    if (!ctx.isMainWorktree) links.push({ path: resolve(ctx.currentWorktree, name), source: main });
  }
  const mainRegistry = registryDir;
  if (
    pathExists(mainRegistry) &&
    (lstatSync(mainRegistry).isSymbolicLink() || !statSync(mainRegistry).isDirectory())
  )
    throw new WorkspaceError(`Conflicting main registry destination: ${mainRegistry}`);
  if (!ctx.isMainWorktree && storage?.in !== "companion")
    links.push({
      path: join(ctx.currentWorktree, ".local-wt", "workspace-registry"),
      source: mainRegistry,
    });
  for (const [index, link] of links.entries()) {
    checkLink(link);
    for (const other of links.slice(index + 1)) {
      if (isInside(link.path, other.path) || isInside(other.path, link.path))
        throw new WorkspaceError(
          `Overlapping shared directory destinations: ${link.path}, ${other.path}`,
        );
    }
  }
  for (const path of filePaths) {
    const destination = assertFileDestination(ctx.currentWorktree, path, registryDir);
    if (
      isInside(storage?.runtimeDir ?? resolve(ctx.currentWorktree, ".local-wt"), destination) ||
      links.some((link) => isInside(link.path, destination) || isInside(destination, link.path))
    )
      throw new WorkspaceError(`File destination overlaps shared or runtime storage: ${path}`);
  }
  return {
    apply: async () => {
      mkdirSync(storage?.runtimeDir ?? join(ctx.currentWorktree, ".local-wt"), { recursive: true });
      mkdirSync(mainRegistry, { recursive: true });
      for (const source of createSources) mkdirSync(source, { recursive: true });
      for (const link of links) {
        checkLink(link);
        if (!pathExists(link.path)) {
          mkdirSync(dirname(link.path), { recursive: true });
          symlinkSync(link.source, link.path, "dir");
        }
      }
      const shared = links.filter(
        (link) =>
          storage?.in === "companion" ||
          !isInside(join(ctx.currentWorktree, ".local-wt"), link.path),
      );
      ensureExclusions(
        source,
        shared.map((link) => relative(ctx.currentWorktree, link.path)),
      );
      for (const link of shared) assertIgnored(target, relative(ctx.currentWorktree, link.path));
      await host.validateWorkFiles(ctx.currentWorktree);
    },
  };
}

export function validateRuntimeStorage(source: GitContext, storage?: WorkspaceStorage): void {
  const selected = storage && resolveWorkspaceStorage(storage, source.cwd);
  if (selected?.in === "companion") {
    assertDirectoryPath(resolve(selected.registryDir, "../.."), selected.runtimeDir);
    assertDirectoryPath(resolve(selected.registryDir, "../.."), selected.registryDir);
  }
  const path = selected?.runtimeDir ?? join(source.cwd, ".local-wt");
  if (selected?.in !== "companion" && targetTracks(source, preparationCommit(source), ".local-wt"))
    throw new WorkspaceError(`Runtime storage is tracked: ${path}`);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
    throw new WorkspaceError(`Runtime storage must be a local directory: ${path}`);
  const logs = join(path, "logs");
  const logsStat = lstatSync(logs, { throwIfNoEntry: false });
  if (logsStat && (!logsStat.isDirectory() || logsStat.isSymbolicLink()))
    throw new WorkspaceError(`Runtime logs must be a local directory: ${logs}`);
  if (logsStat) {
    for (const name of readdirSync(logs)) {
      const file = join(logs, name);
      if (!lstatSync(file).isFile())
        throw new WorkspaceError(`Conflicting runtime log destination: ${file}`);
    }
  }
  // Directory-only ignore rules count before the directory exists; symlinks never do.
  if (selected?.in !== "companion") assertIgnored(source, ".local-wt/");
}

function assertIgnored(source: GitContext, path: string): void {
  try {
    git(source, "check-ignore", "-q", "--", path);
  } catch {
    throw new WorkspaceError(
      `Path is not ignored: ${join(source.cwd, path)}. Add effective local Git exclusions or prepare shared/companion work files before retrying; tracked ignore rules were not edited.`,
    );
  }
}

function checkLink(link: Link): void {
  if (!pathExists(link.path)) return;
  try {
    if (
      lstatSync(link.path).isSymbolicLink() &&
      realpathSync(link.path) === canonicalPath(link.source)
    )
      return;
  } catch {
    /* Broken and cyclic links are conflicts. */
  }
  throw new WorkspaceError(
    `Conflicting shared directory destination: ${link.path}. Existing content was preserved.`,
  );
}

function ensureExclusions(source: GitContext, names: string[]): void {
  if (names.length === 0) return;
  const path = git(
    source,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ).trim();
  let content = pathExists(path) ? readFileSync(path, "utf8") : "";
  for (const name of names) {
    const pattern = `/${name}`;
    if (content.split(/\r?\n/u).includes(pattern)) continue;
    mkdirSync(dirname(path), { recursive: true });
    const addition = `${content === "" || content.endsWith("\n") ? "" : "\n"}${pattern}\n`;
    appendFileSync(path, addition);
    content += addition;
  }
}
