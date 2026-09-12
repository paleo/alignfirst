import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { CliError } from "../cli-error.js";
import type { Output } from "../context.js";
import { gitOutput, gitOutputRaw } from "../git.js";
import { nextFilePosition } from "./ticket.js";

interface Resolution {
  files: Map<string, PreservedFile>;
  renames: Map<string, string>;
  reserved: Set<string>;
}

interface PreservedFile {
  blob: Blob;
  localPath?: string;
}

interface Blob {
  id: string;
  mode: string;
}

export function resolveConflictedPaths(repoDir: string, stdout: Output): void {
  const conflicts = readConflicts(repoDir);
  const remote = readTree(repoDir, "HEAD");
  const local = readTree(repoDir, "REBASE_HEAD");
  const resolution: Resolution = {
    files: new Map(),
    renames: new Map(),
    reserved: new Set([...remote.keys(), ...local.keys()]),
  };
  for (const [path, stages] of conflicts) {
    const ours = conflictBlob(path, stages.has(2), remote);
    const theirs = conflictBlob(path, stages.has(3), local);
    if (!ours && !theirs && (remote.has(path) || local.has(path)))
      throw new CliError(`Cannot recover both versions of ${path}. Resolve the rebase manually.`);
    if (ours) resolution.files.set(path, { blob: ours });
    if (!theirs) continue;
    if (ours && (ours.id !== theirs.id || ours.mode !== theirs.mode)) {
      preserveLocalCopy(repoDir, path, theirs, resolution);
    } else {
      resolution.files.set(path, { blob: theirs, localPath: path });
    }
  }
  preserveCompanionSummaries(repoDir, remote, local, resolution);
  preserveLocalReferences(repoDir, remote, local, resolution);
  assertNoLaterEdits(repoDir, resolution.renames);
  applyResolution(repoDir, conflicts, resolution);
  for (const path of conflicts.keys()) {
    const renamed = resolution.renames.get(path);
    stdout.write(
      renamed === undefined
        ? `Resolved ${path}: preserved committed contents at the surviving paths.\n`
        : `Resolved ${path}: kept the published version; saved the local version as ${renamed}.\n`,
    );
  }
}

function readConflicts(repoDir: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const entry of gitOutputRaw(repoDir, "ls-files", "-u", "-z").split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    const header = entry.slice(0, tab).split(" ");
    const stage = Number(header[2]);
    if (tab === -1 || ![1, 2, 3].includes(stage))
      throw new CliError("Could not read the conflicted plans index.");
    const path = entry.slice(tab + 1);
    const stages = result.get(path) ?? new Set<number>();
    stages.add(stage);
    result.set(path, stages);
  }
  return result;
}

function readTree(repoDir: string, commit: string): Map<string, Blob> {
  const result = new Map<string, Blob>();
  for (const entry of gitOutputRaw(repoDir, "ls-tree", "-r", "-z", commit).split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    const [mode, , id] = entry.slice(0, tab).split(" ");
    result.set(entry.slice(tab + 1), { id, mode });
  }
  return result;
}

function conflictBlob(
  path: string,
  present: boolean,
  tree: ReadonlyMap<string, Blob>,
): Blob | undefined {
  if (!present) return;
  const blob = tree.get(path);
  if (!blob || !["100644", "100755"].includes(blob.mode))
    throw new CliError(
      `Cannot automatically preserve conflict at ${path}. Resolve the rebase manually.`,
    );
  return blob;
}

function preserveLocalCopy(
  repoDir: string,
  path: string,
  blob: Blob,
  resolution: Resolution,
): void {
  const target = freeLocalPath(repoDir, path, resolution.reserved);
  resolution.renames.set(path, target);
  resolution.reserved.add(target);
  resolution.files.set(target, { blob, localPath: path });
}

function freeLocalPath(repoDir: string, path: string, reserved: Set<string>): string {
  const dir = dirname(path);
  const names = [
    ...readdirSync(join(repoDir, dir)),
    ...[...reserved].filter((entry) => dirname(entry) === dir).map((entry) => basename(entry)),
  ];
  const name = basename(path);
  const numbered = /^[A-Z]\d+-(.+)$/s.exec(name);
  const { cycleLetter, fileNumber } = nextFilePosition(names, false);
  const extension = name.endsWith(".summary.md") ? ".summary.md" : extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let offset = 0; ; ++offset) {
    const candidate = join(
      dir,
      numbered
        ? `${cycleLetter}${fileNumber + offset}-${numbered[1]}`
        : `${stem}-local-${offset + 2}${extension}`,
    );
    if (reserved.has(candidate) || lstatSync(join(repoDir, candidate), { throwIfNoEntry: false }))
      continue;
    const companion = `${candidate.slice(0, -3)}.summary.md`;
    if (
      name.endsWith(".md") &&
      reserved.has(`${path.slice(0, -3)}.summary.md`) &&
      (reserved.has(companion) || lstatSync(join(repoDir, companion), { throwIfNoEntry: false }))
    )
      continue;
    return candidate;
  }
}

function preserveCompanionSummaries(
  repoDir: string,
  remote: ReadonlyMap<string, Blob>,
  local: ReadonlyMap<string, Blob>,
  resolution: Resolution,
): void {
  for (const [source, target] of resolution.renames) {
    if (!source.endsWith(".md")) continue;
    const companion = `${source.slice(0, -3)}.summary.md`;
    const blob = local.get(companion);
    if (!blob) continue;
    const companionTarget = `${target.slice(0, -3)}.summary.md`;
    if (
      resolution.reserved.has(companionTarget) ||
      lstatSync(join(repoDir, companionTarget), { throwIfNoEntry: false })
    )
      throw new CliError(
        `Cannot preserve related summary ${companion}: ${companionTarget} exists.`,
      );
    conflictBlob(companion, true, local);
    const previousTarget = resolution.renames.get(companion);
    if (previousTarget !== undefined) resolution.files.delete(previousTarget);
    resolution.renames.set(companion, companionTarget);
    resolution.reserved.add(companionTarget);
    resolution.files.set(companionTarget, { blob, localPath: companion });
    const published = conflictBlob(companion, remote.has(companion), remote);
    if (published) resolution.files.set(companion, { blob: published });
    else resolution.files.delete(companion);
  }
}

function preserveLocalReferences(
  repoDir: string,
  remote: ReadonlyMap<string, Blob>,
  local: ReadonlyMap<string, Blob>,
  resolution: Resolution,
): void {
  if (resolution.renames.size === 0) return;
  const published = readTree(repoDir, rebaseCommit(repoDir, "onto"));
  const added = new Set(
    gitOutputRaw(repoDir, "diff", "--cached", "--name-only", "--diff-filter=A", "-z")
      .split("\0")
      .filter((path) => path !== ""),
  );
  for (const [path, blob] of local) {
    if (
      !path.endsWith(".md") ||
      (!added.has(path) && (!remote.has(path) || published.has(path))) ||
      resolution.renames.has(path)
    )
      continue;
    if (blob.mode === "100644" || blob.mode === "100755")
      resolution.files.set(path, { blob, localPath: path });
  }
}

function rebaseCommit(repoDir: string, name: string): string {
  const state = gitOutput(repoDir, "rev-parse", "--git-path", `rebase-merge/${name}`);
  const path = resolve(repoDir, state);
  if (!lstatSync(path, { throwIfNoEntry: false }))
    throw new CliError("Cannot read the original rebase commits. Resolve the rebase manually.");
  return readFileSync(path, "utf8").trim();
}

function assertNoLaterEdits(repoDir: string, renames: ReadonlyMap<string, string>): void {
  if (renames.size === 0) return;
  const originalHead = rebaseCommit(repoDir, "orig-head");
  const commits = gitOutput(repoDir, "rev-list", `REBASE_HEAD..${originalHead}`);
  for (const commit of commits.split("\n").filter((value) => value !== "")) {
    const tree = readTree(repoDir, commit);
    const paths = gitOutputRaw(
      repoDir,
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      commit,
    );
    for (const path of paths.split("\0")) {
      if (renames.has(path))
        throw new CliError(
          `Cannot automatically rename ${path}: a later local commit edits it. Resolve the rebase manually.`,
        );
      const blob = tree.get(path);
      if (!path.endsWith(".md") || !blob || !["100644", "100755"].includes(blob.mode)) continue;
      const content = readBlob(repoDir, blob);
      if (!updateReferences(content, path, renames).equals(content))
        throw new CliError(
          `A later local commit references a renamed document in ${path}. Resolve the rebase manually.`,
        );
    }
  }
}

function readBlob(repoDir: string, blob: Blob): Buffer {
  return execFileSync("git", ["-C", repoDir, "cat-file", "blob", blob.id]);
}

function updateReferences(
  original: Buffer,
  source: string,
  renames: ReadonlyMap<string, string>,
): Buffer {
  const replacements = new Map<string, string>();
  for (const [before, after] of renames) {
    replacements.set(before, after);
    const from = relative(dirname(source), before);
    const to = relative(dirname(source), after);
    replacements.set(from, to);
    replacements.set(`./${from}`, `./${to}`);
    // A shared plans clone stores the project's .plans directory under its configured folder.
    replacements.set(before.replace(/^[^/]+\//, ".plans/"), after.replace(/^[^/]+\//, ".plans/"));
  }
  if (replacements.size === 0) return original;
  const pattern = [...replacements.keys()]
    .sort((left, right) => right.length - left.length)
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const text = original.toString("utf8");
  if (!Buffer.from(text).equals(original)) return original;
  const updated = text.replace(
    new RegExp(`(?<![\\w./-])(?:${pattern})(?=$|[\\s\x60'"<>()[\\]#:])`, "g"),
    (match) => replacements.get(match) ?? match,
  );
  return Buffer.from(updated);
}

function applyResolution(
  repoDir: string,
  conflicts: ReadonlyMap<string, Set<number>>,
  resolution: Resolution,
): void {
  const removed = [...new Set([...conflicts.keys(), ...resolution.renames.keys()])].filter(
    (path) => !resolution.files.has(path),
  );
  for (const path of [...removed, ...resolution.files.keys()]) assertRegularPath(repoDir, path);
  const writes = [...resolution.files].map(([path, file]) => {
    const original = readBlob(repoDir, file.blob);
    const content =
      file.localPath !== undefined && path.endsWith(".md")
        ? updateReferences(original, file.localPath, resolution.renames)
        : original;
    return { path, content, mode: file.blob.mode === "100755" ? 0o755 : 0o644 };
  });
  for (const path of removed) rmSync(join(repoDir, path), { force: true });
  for (const { path, content, mode } of writes) {
    const target = join(repoDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    chmodSync(target, mode);
  }
}

function assertRegularPath(repoDir: string, path: string): void {
  const stat = lstatSync(join(repoDir, path), { throwIfNoEntry: false });
  if (stat && !stat.isFile())
    throw new CliError(`Cannot automatically replace ${path}. Resolve the rebase manually.`);
  for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
    const parent = lstatSync(join(repoDir, dir), { throwIfNoEntry: false });
    if (parent && !parent.isDirectory())
      throw new CliError(`Cannot automatically write through ${dir}. Resolve the rebase manually.`);
  }
}
