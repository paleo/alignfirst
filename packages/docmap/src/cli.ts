import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  checkAll,
  collectAllFiles,
  countFilesUpTo,
  formatDirectory,
  formatRecursive,
  isUnder,
  listDirectory,
  readDocFile,
  searchDocs,
  type FormatResult,
} from "./formatter.js";

// A bare invocation over fewer listable files than this lists recursively by default.
const SMALL_SET_THRESHOLD = 20;

// Appended under the title when a listing target holds no documents, so an empty folder reads as
// deliberate rather than a silent, truncated listing.
const EMPTY_LISTING_NOTE = "_No documents here._";

export interface MainOptions {
  argv?: string[];
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  cwd?: string;
  userAgent?: string;
}

export function main(options?: MainOptions): number {
  const argv = options?.argv ?? process.argv;
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const cwd = options?.cwd ?? process.cwd();
  const userAgent = options?.userAgent ?? process.env.npm_config_user_agent ?? "";

  const { paths, unknownFlags, recursive, root, check, help, guide, search, version } =
    parseArgs(argv);
  const baseDir = root ? resolve(cwd, root) : resolve(cwd, "docs");
  // cwd-relative form of baseDir, prepended to every displayed path so output is copy-pasteable.
  // A `--root` outside cwd yields a `..`-leading prefix; paths still strip and resolve correctly.
  const prefix = relative(cwd, baseDir);

  for (const flag of unknownFlags) stderr.write(`Unknown option: ${flag} (ignored)\n`);

  // Fold an explicit `--root` into every suggested command so each one is copy-pasteable against the
  // same custom root; `showRootOption` then drops the now-redundant `--root <path>` help row.
  const pm = commandsWithRoot(detectPackageManager(cwd, userAgent), root);
  const showRootOption = root === undefined;

  // Mode precedence (each prints only its own output, then returns): version → help → guide →
  // search → check → listing/read.
  if (version) {
    stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }
  if (help) {
    stdout.write(renderHelp(pm, { full: true, showRootOption }));
    return 0;
  }
  if (guide) {
    stdout.write(renderGuide(pm));
    return 0;
  }
  if (search !== undefined) {
    const terms = search.split(/\s+/).filter((term) => term.length > 0);
    const lines = searchDocs(baseDir, terms, prefix);
    stdout.write(
      lines.length > 0 ? `${lines.join("\n")}\n` : `No documents match: ${terms.join(" ")}\n`,
    );
    return 0;
  }
  if (check) {
    const issues = checkAll(baseDir, "", prefix);
    for (const issue of issues) stdout.write(`${issue.path}: ${issue.message}\n`);
    return issues.length > 0 ? 1 : 0;
  }

  // A bare invocation always prefixes the listing with short help, so the command vocabulary
  // stays discoverable no matter how large the tree is. The set size governs only the listing
  // shape: a small set lists recursively, a large one keeps the top-level listing to avoid
  // dumping the whole tree. The threshold check walks the tree (capped at SMALL_SET_THRESHOLD),
  // and renderListing below walks it again to format — an intentional double traversal,
  // negligible at this threshold and not worth threading a shared pass through.
  const bare = paths.length === 0 && !recursive;
  if (bare) stdout.write(`${renderHelp(pm, { full: false, showRootOption })}\n`);
  const smallSet = bare && countFilesUpTo(baseDir, SMALL_SET_THRESHOLD) < SMALL_SET_THRESHOLD;

  const { dirs, files } = classifyTargets(baseDir, paths, prefix);

  const listing = renderListing(baseDir, dirs, recursive || smallSet, paths.length === 0, prefix);
  if (listing) stdout.write(listing);

  const reads = renderReads(baseDir, files, prefix);
  if (reads) {
    if (listing) stdout.write("\n");
    stdout.write(reads);
  }

  return 0;
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version?: string;
  };
  if (!pkg.version) throw new Error("docmap: package.json is missing 'version'");
  return pkg.version;
}

export interface ParsedArgs {
  paths: string[];
  unknownFlags: string[];
  recursive: boolean;
  root: string | undefined;
  check: boolean;
  help: boolean;
  guide: boolean;
  search: string | undefined;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const paths: string[] = [];
  const unknownFlags: string[] = [];
  let recursive = false;
  let root: string | undefined;
  let check = false;
  let help = false;
  let guide = false;
  let search: string | undefined;
  let version = false;

  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    if (arg === "--root" && i + 1 < args.length) {
      root = args[++i];
    } else if (arg === "--search" && i + 1 < args.length) {
      search = args[++i];
    } else if (arg === "--recursive") {
      recursive = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--help") {
      help = true;
    } else if (arg === "--guide") {
      guide = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg.startsWith("--")) {
      unknownFlags.push(arg);
    } else {
      paths.push(arg);
    }
  }

  return { paths, unknownFlags, recursive, root, check, help, guide, search, version };
}

interface HelpOptions {
  full: boolean;
  showRootOption: boolean;
}

interface PackageManagerCommands {
  base: string;
  withArgs: string;
}

interface CommandRow {
  command: string;
  comment: string;
}

// Pad every command to the longest one so the `#` comments line up, whatever the
// package-manager prefix length (npm's `run … --` vs a bare `pnpm docmap`). This
// is why the command lists for short help, full help, and the guide all render
// through one helper instead of carrying hand-counted padding.
function renderCommands(rows: CommandRow[]): string {
  const width = Math.max(...rows.map((row) => row.command.length));
  return rows.map((row) => `${row.command.padEnd(width)} # ${row.comment}`).join("\n");
}

// Everyday browse/search commands, shared by short help, full help, and the guide.
// Examples carry the `docs/` prefix to nudge agents toward valid, openable paths.
function browseCommands(pm: PackageManagerCommands): CommandRow[] {
  return [
    { command: pm.base, comment: "list root documents" },
    { command: `${pm.withArgs} dir-a`, comment: "list a sub-directory" },
    { command: `${pm.withArgs} docs/dir-a/doc-1.md`, comment: "read a document" },
    {
      command: `${pm.withArgs} docs/dir-a/doc-1.md docs/doc-2.md dir-b`,
      comment: "several at once",
    },
    { command: `${pm.withArgs} --recursive`, comment: "list every document" },
    {
      command: `${pm.withArgs} --search "term1 term2"`,
      comment: "search path and frontmatter (title, summary, read_when)",
    },
  ];
}

// The `--root <path>` row documents the option only when no root is active; once a real root is
// folded into `pm` (see `commandsWithRoot`), every command already carries it, so the row is dropped
// to avoid a doubled `--root`.
function moreCommands(pm: PackageManagerCommands, showRootOption: boolean): CommandRow[] {
  const rows: CommandRow[] = [
    { command: `${pm.withArgs} --check`, comment: "validate names and frontmatter" },
  ];
  if (showRootOption)
    rows.push({ command: `${pm.withArgs} --root <path>`, comment: "use a custom docs root" });
  rows.push({
    command: `${pm.withArgs} -v`,
    comment: "print the docmap version (alias: --version)",
  });
  return rows;
}

// The guide shows the browse/search set plus validation.
function guideCommands(pm: PackageManagerCommands): CommandRow[] {
  return [
    ...browseCommands(pm),
    { command: `${pm.withArgs} --check`, comment: "validate all files" },
  ];
}

function renderHelp(pm: PackageManagerCommands, { full, showRootOption }: HelpOptions): string {
  const lines = [
    "docmap — browse and read a project's docs/ tree of Markdown files.",
    "",
    "Commands:",
    "",
    "```",
    renderCommands(browseCommands(pm)),
    "```",
    "",
    `Before writing a new document or editing an existing one, run \`${pm.withArgs} --guide\` and follow its rules.`,
  ];
  if (full) {
    lines.push(
      "",
      "More:",
      "```",
      renderCommands(moreCommands(pm, showRootOption)),
      "```",
      "",
      "Positional paths are classified by the filesystem: a directory is listed, a file is read,",
      "an unmatched name falls back to a fuzzy basename search. The docs/ prefix is optional on input.",
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderGuide(pm: PackageManagerCommands): string {
  const template = readFileSync(new URL("../templates/guide.md", import.meta.url), "utf-8");
  return template
    .replaceAll("{{COMMANDS}}", renderCommands(guideCommands(pm)))
    .replaceAll("{{PM_ARGS}}", pm.withArgs)
    .replaceAll("{{PM}}", pm.base);
}

interface ClassifiedTargets {
  dirs: string[];
  files: FileTarget[];
}

interface FileTarget {
  original: string;
  normalized: string;
}

function classifyTargets(baseDir: string, paths: string[], prefix: string): ClassifiedTargets {
  const dirs: string[] = [];
  const files: FileTarget[] = [];
  for (const original of paths) {
    const normalized = normalizeTarget(original, prefix);
    const resolved = resolve(baseDir, normalized);
    // Only list a target as a directory when it stays under baseDir. Traversal (`..`) or absolute
    // paths fall through to files, where readDocFile rejects them with the "⚠ Not found" message.
    if (isUnder(baseDir, resolved) && isDirectory(resolved)) dirs.push(normalized);
    else files.push({ original, normalized });
  }
  return { dirs, files };
}

function normalizeTarget(arg: string, prefix: string): string {
  const trimmed = arg.replace(/\/+$/, "");
  if (prefix.length > 0 && (trimmed === prefix || trimmed.startsWith(`${prefix}/`)))
    return trimmed.slice(prefix.length).replace(/^\/+/, "");
  return trimmed;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function renderListing(
  baseDir: string,
  dirs: string[],
  recursive: boolean,
  noPositionals: boolean,
  prefix: string,
): string {
  const targets = listingTargets(baseDir, dirs, recursive, noPositionals);
  if (targets.length === 0) return "";

  const allLines: string[] = [];
  for (const target of targets) allLines.push(...renderListingTarget(target, recursive, prefix));
  return allLines.join("\n");
}

// The root target can point at a folder that does not exist (no `docs/`, or a `--root` never
// created); any target can exist yet hold no documents. Each gets an explicit line so the output
// never degrades to a bare title with nothing under it.
function renderListingTarget(target: ListingTarget, recursive: boolean, prefix: string): string[] {
  const { targetDir, rootTitle, rootRelDir } = target;
  if (!existsSync(targetDir)) return [missingFolderMessage(prefix), ""];

  const formatted: FormatResult = recursive
    ? formatRecursive(targetDir, rootTitle, 1, rootRelDir, prefix)
    : formatDirectory(targetDir, rootTitle, listDirectory(targetDir), rootRelDir, prefix);
  if (formatted.hasFiles || formatted.hasSubdirList) return formatted.lines;
  return [...formatted.lines, EMPTY_LISTING_NOTE, ""];
}

function missingFolderMessage(prefix: string): string {
  const where = prefix.length > 0 ? `\`${prefix}/\`` : "the documentation root";
  return `No documentation folder at ${where}.`;
}

interface ListingTarget {
  targetDir: string;
  rootTitle: string;
  rootRelDir: string;
}

function listingTargets(
  baseDir: string,
  dirs: string[],
  recursive: boolean,
  noPositionals: boolean,
): ListingTarget[] {
  if (dirs.length > 0)
    return dirs.map((dir) => ({
      targetDir: resolve(baseDir, dir),
      rootTitle: dir ? `${dir}/` : "Documentation",
      rootRelDir: dir,
    }));
  if (noPositionals || recursive)
    return [{ targetDir: baseDir, rootTitle: "Documentation", rootRelDir: "" }];
  return [];
}

function renderReads(baseDir: string, files: FileTarget[], prefix: string): string {
  if (files.length === 0) return "";
  let cachedFiles: string[] | undefined;
  const getAllFiles = (): string[] => (cachedFiles ??= collectAllFiles(baseDir, ""));
  const blocks = files.map(({ original, normalized }) => {
    const result = readDocFile(baseDir, normalized, prefix, getAllFiles);
    if (!result) return `⚠ Not found: ${original}`;
    return `<document_file path="${result.path}">\n${result.content.trimEnd()}\n</document_file>`;
  });
  return `${blocks.join("\n\n")}\n`;
}

// Fold an explicit `--root <value>` into the command prefix so every suggested command targets the
// same custom root. Adding an argument means npm needs its `--` separator, so both forms derive from
// `withArgs` (which already carries it), not from the argument-less `base`.
function commandsWithRoot(
  pm: PackageManagerCommands,
  root: string | undefined,
): PackageManagerCommands {
  if (root === undefined) return pm;
  const rooted = `${pm.withArgs} --root ${shellQuoteArg(root)}`;
  return { base: rooted, withArgs: rooted };
}

// Quote a root that carries spaces or shell metacharacters so the suggested command stays
// copy-pasteable; a clean path is left bare.
function shellQuoteArg(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function detectPackageManager(cwd: string, userAgent: string): PackageManagerCommands {
  // We read the actual invocation, not the environment. `npm_config_user_agent` is set by every
  // package-manager-mediated launch (`npm run`, `pnpm`, npx/dlx/bunx) and empty for a bare global
  // binary. An empty agent therefore means the user ran the global `docmap` directly — so bare
  // `docmap` is the command that just worked, and the only one we can guarantee works here. We
  // suggest it even inside a project with a lockfile: a nearby lockfile does not imply a `docmap`
  // script, and `npm run docmap` would then be a dead command. A user who wants the project's
  // pinned version runs `npm run docmap` themselves, which sets the agent and takes the walk below.
  if (userAgent === "") return sameCommand("docmap");

  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, "package-lock.json")))
      return { base: "npm run docmap", withArgs: "npm run docmap --" };
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return sameCommand("pnpm docmap");
    if (existsSync(join(dir, "yarn.lock"))) return sameCommand("yarn docmap");
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")))
      return sameCommand("bun run docmap");
    const parent = dirname(dir);
    if (parent === dir) return runnerCommand(userAgent);
    dir = parent;
  }
}

// A package manager launched us (agent is set) but no lockfile was found: docmap is not wired as a
// project script, so suggest the manager's package-runner form, defaulting to npx (every Node
// install ships it). A global install invoked through `npx @paleo/docmap` lands here too and
// correctly keeps the npx suggestion.
function runnerCommand(userAgent: string): PackageManagerCommands {
  if (userAgent.startsWith("pnpm")) return sameCommand("pnpm dlx @paleo/docmap");
  if (userAgent.startsWith("yarn")) return sameCommand("yarn dlx @paleo/docmap");
  if (userAgent.startsWith("bun")) return sameCommand("bunx @paleo/docmap");
  return sameCommand("npx @paleo/docmap");
}

// Only npm needs a `--` separator before forwarded args; every other manager passes them verbatim.
function sameCommand(command: string): PackageManagerCommands {
  return { base: command, withArgs: command };
}
