import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  type CopyAndPatchOutcome,
  copyAndPatchFile,
  type ExistingFilePolicy,
  type ResolvedFileSource,
} from "./helpers.js";

/** Shared core of the setup-side callback contexts. */
export interface SetupContextBase {
  /** Registered workspace name; it may differ from the worktree directory basename. */
  name: string;
  currentWorktree: string;
  mainWorktree: string;
  /** `true` when operating on the main worktree. */
  isMainWorktree: boolean;
  signal?: AbortSignal;
}

/** Context passed to functional content sources and {@link GitignoredFileEntry.patch}. */
export interface PatchContext extends SetupContextBase {}

/** One gitignored file seeded from its source and patched per workspace. */
export interface GitignoredFileEntry {
  /** Path relative to the worktree root. Written to the current worktree. */
  path: string;
  /** Where the initial content comes from. */
  source: GitignoredFileSource;
  /**
   * Rewrites the source content per workspace. Omit to copy the content verbatim. When the file
   * already exists, `setup` re-applies it to the current content and rewrites the file only when
   * the result differs. It must leave the lines it does not know untouched; `setup` refuses (throws)
   * a patch that is not idempotent.
   */
  patch?: (content: string, ctx: PatchContext) => string | Promise<string>;
  validateDestination?: (ctx: PatchContext) => void;
  /**
   * When `true`, a missing source file logs a warning and skips the entry instead of aborting.
   * Applies to the selected path for `mainWorktree` and `committed` sources; ignored for `content`.
   */
  optional?: boolean;
}

/**
 * Where a file entry's initial content comes from. `C` is the context of a functional content
 * source.
 */
export type GitignoredFileSource<C extends SetupContextBase = PatchContext> =
  | MainWorktreeSource
  | CommittedSource
  | ContentSource<C>;

/** Copies the entry path from the main worktree, or a committed fallback when it is absent. */
export interface MainWorktreeSource {
  kind: "mainWorktree";
  /** Optional template path relative to the current worktree. */
  fallback?: string;
}

/** Copies a committed template from the worktree's own checkout, so it tracks the branch. */
export interface CommittedSource {
  kind: "committed";
  /** Path of the template, relative to the worktree root (e.g. a committed `.example` file). */
  path: string;
}

/** Uses the given content verbatim. The function form receives the entry's context and may be async. */
export interface ContentSource<C extends SetupContextBase = PatchContext> {
  kind: "content";
  content: string | ((ctx: C) => string | Promise<string>);
}

/** One gitignored file that carries ports or is needed only to run. Written by every `dev setup`. */
export interface RunFileEntry {
  /** Path relative to the worktree root. */
  path: string;
  /** Where a missing file's initial content comes from. */
  source: GitignoredFileSource<RunFileContext>;
  /** Omit to copy verbatim. Same contract as `GitignoredFileEntry.patch`. */
  patch?: (content: string, ctx: RunFileContext) => string | Promise<string>;
  validateDestination?: (ctx: RunFileContext) => void;
  /** Same contract as `GitignoredFileEntry.optional`. */
  optional?: boolean;
}

/** Context passed to the functional content sources and patches of {@link RunFileEntry}. */
export interface RunFileContext extends SetupContextBase {
  ports: Record<string, number>;
}

/** The shape shared by {@link GitignoredFileEntry} and {@link RunFileEntry}. */
export interface SeededFile<C extends SetupContextBase> {
  path: string;
  source: GitignoredFileSource<C>;
  patch?: (content: string, ctx: C) => string | Promise<string>;
  validateDestination?: (ctx: C) => void;
  optional?: boolean;
}

export interface SeedLog {
  /** Shown always: the `Updated <paths>` line. */
  tee: (msg: string) => void;
  /** The other outcomes, one line per file. */
  verbose: (msg: string) => void;
}

export interface SeedFilesInput<C extends SetupContextBase> {
  entries: Iterable<SeededFile<C>> | AsyncIterable<SeededFile<C>>;
  ctx: C;
  /** What happens to an existing file. */
  existing: ExistingFilePolicy;
  log: SeedLog;
}

/**
 * Writes each entry with {@link copyAndPatchFile}. The rewritten files are reported in one
 * `Updated <paths>` line, also when a later entry fails.
 */
export async function seedFiles<C extends SetupContextBase>(
  input: SeedFilesInput<C>,
): Promise<void> {
  const { ctx, log } = input;
  const updated: string[] = [];
  try {
    for await (const entry of input.entries) {
      ctx.signal?.throwIfAborted();
      const { patch } = entry;
      const outcome = await copyAndPatchFile({
        currentWorktree: ctx.currentWorktree,
        relPath: entry.path,
        resolveSource: () => resolveFileSource(entry, ctx),
        patch: patch ? (content: string) => patch(content, ctx) : undefined,
        existing: input.existing,
        optional: entry.optional ?? false,
        signal: ctx.signal,
        validateDestination: () => entry.validateDestination?.(ctx),
      });
      if (outcome.kind === "updated") updated.push(entry.path);
      else log.verbose(outcomeLine(entry.path, outcome));
    }
  } finally {
    if (updated.length > 0) log.tee(`Updated ${updated.join(", ")}.`);
  }
}

function outcomeLine(
  relPath: string,
  outcome: Exclude<CopyAndPatchOutcome, { kind: "updated" }>,
): string {
  switch (outcome.kind) {
    case "created":
      return `Created ${relPath}.`;
    case "overwritten":
      return `Overwritten ${relPath}.`;
    case "upToDate":
      return `Skipped ${relPath} (already up to date).`;
    case "keptExisting":
      return `Skipped ${relPath} (already exists; use --force to overwrite).`;
    case "sourceMissing":
      return `Warning: source ${outcome.sourcePath} not found, skipping (optional).`;
  }
}

/** In the main worktree, a `mainWorktree` source resolves to the entry's own file. */
export async function resolveFileSource<C extends SetupContextBase>(
  entry: { path: string; source: GitignoredFileSource<C> },
  ctx: C,
): Promise<ResolvedFileSource> {
  const { source } = entry;
  switch (source.kind) {
    case "mainWorktree": {
      const mainPath = join(ctx.mainWorktree, entry.path);
      if (existsSync(mainPath) || source.fallback === undefined) return { path: mainPath };
      return { path: join(ctx.currentWorktree, source.fallback) };
    }
    case "committed":
      return { path: join(ctx.currentWorktree, source.path) };
    case "content":
      return {
        content: typeof source.content === "function" ? await source.content(ctx) : source.content,
      };
  }
}
