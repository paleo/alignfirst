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

// A bare invocation over fewer .md files than this lists recursively by default.
const SMALL_SET_THRESHOLD = 20;

export interface MainOptions {
  argv?: string[];
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  cwd?: string;
}

export function main(options?: MainOptions): number {
  const argv = options?.argv ?? process.argv;
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const cwd = options?.cwd ?? process.cwd();

  const { paths, unknownFlags, recursive, root, check, help, guide, search } = parseArgs(argv);
  const baseDir = root ? resolve(cwd, root) : resolve(cwd, "docs");
  // cwd-relative form of baseDir, prepended to every displayed path so output is copy-pasteable.
  // A `--root` outside cwd yields a `..`-leading prefix; paths still strip and resolve correctly.
  const prefix = relative(cwd, baseDir);

  for (const flag of unknownFlags) stderr.write(`Unknown option: ${flag} (ignored)\n`);

  const pm = detectPackageManager(cwd);

  // Mode precedence (each prints only its own output, then returns): help → guide → search →
  // check → listing/read.
  if (help) {
    stdout.write(renderHelp(pm, { full: true }));
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

  // A bare invocation over a small doc set lists recursively and is the only case that
  // prefixes the listing with short help. The threshold check walks the tree (capped at
  // SMALL_SET_THRESHOLD), and renderListing below walks it again to format — an intentional
  // double traversal, negligible at this threshold and not worth threading a shared pass through.
  const bare = paths.length === 0 && !recursive;
  const smallSet = bare && countFilesUpTo(baseDir, SMALL_SET_THRESHOLD) < SMALL_SET_THRESHOLD;
  if (smallSet) stdout.write(`${renderHelp(pm, { full: false })}\n`);

  const { dirs, files } = classifyTargets(baseDir, paths, prefix);

  const listing = renderListing(
    baseDir,
    dirs,
    recursive || smallSet,
    paths.length === 0,
    cwd,
    prefix,
  );
  if (listing) stdout.write(listing);

  const reads = renderReads(baseDir, files, prefix);
  if (reads) {
    if (listing) stdout.write("\n");
    stdout.write(reads);
  }

  return 0;
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
    } else if (arg.startsWith("--")) {
      unknownFlags.push(arg);
    } else {
      paths.push(arg);
    }
  }

  return { paths, unknownFlags, recursive, root, check, help, guide, search };
}

interface HelpOptions {
  full: boolean;
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
function renderCommands(rows: CommandRow[], indent = ""): string {
  const width = Math.max(...rows.map((row) => row.command.length));
  return rows.map((row) => `${indent}${row.command.padEnd(width)} # ${row.comment}`).join("\n");
}

// Everyday browse/search commands, shared by short help, full help, and the guide.
// Examples carry the `docs/` prefix to nudge agents toward valid, openable paths.
function browseCommands(pm: PackageManagerCommands): CommandRow[] {
  return [
    { command: pm.base, comment: "list root documents" },
    { command: `${pm.withArgs} docs/topic-a`, comment: "list a sub-directory" },
    { command: `${pm.withArgs} docs/intro.md`, comment: "read a document" },
    { command: `${pm.withArgs} docs/intro.md docs/setup.md`, comment: "read several at once" },
    { command: `${pm.withArgs} --recursive`, comment: "list every document" },
    {
      command: `${pm.withArgs} --search "term1 term2"`,
      comment: "search frontmatter (title, summary, read_when)",
    },
  ];
}

function moreCommands(pm: PackageManagerCommands): CommandRow[] {
  return [
    { command: `${pm.withArgs} --check`, comment: "validate names and frontmatter" },
    { command: `${pm.withArgs} --root <path>`, comment: "use a custom docs root" },
  ];
}

// The guide shows the browse/search set plus validation.
function guideCommands(pm: PackageManagerCommands): CommandRow[] {
  return [
    ...browseCommands(pm),
    { command: `${pm.withArgs} --check`, comment: "validate all files" },
  ];
}

function renderHelp(pm: PackageManagerCommands, { full }: HelpOptions): string {
  const lines = [
    "docmap — browse and read a project's docs/ tree of Markdown files.",
    "",
    "Commands:",
    renderCommands(browseCommands(pm), "  "),
    "",
    `To write documentation, run \`${pm.withArgs} --guide\` first.`,
  ];
  if (full) {
    lines.push(
      "",
      "More:",
      renderCommands(moreCommands(pm), "  "),
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
  cwd: string,
  prefix: string,
): string {
  const targets = listingTargets(baseDir, dirs, recursive, noPositionals);
  if (targets.length === 0) return "";

  const allLines: string[] = [];
  let anySubdirList = false;
  let anyFiles = false;
  for (const { targetDir, rootTitle, rootRelDir } of targets) {
    const formatted: FormatResult = recursive
      ? formatRecursive(targetDir, rootTitle, 1, rootRelDir, prefix)
      : formatDirectory(targetDir, rootTitle, listDirectory(targetDir), rootRelDir, prefix);
    allLines.push(...formatted.lines);
    if (formatted.hasSubdirList) anySubdirList = true;
    if (formatted.hasFiles) anyFiles = true;
  }

  let out = `${allLines.join("\n")}\n`;
  const tip = formatTip(anySubdirList, anyFiles, prefix, cwd);
  if (tip) out += tip;
  return out;
}

function formatTip(
  anySubdirList: boolean,
  anyFiles: boolean,
  prefix: string,
  cwd: string,
): string | undefined {
  const examples: string[] = [];
  if (anySubdirList) examples.push("dir-name-a", "dir-name-b");
  if (anyFiles)
    examples.push(
      displayExample(prefix, "dir-name-a", "doc-1.md"),
      displayExample(prefix, "dir-name-b", "doc-2.md"),
    );
  if (examples.length === 0) return;
  const { withArgs } = detectPackageManager(cwd);
  return `Tip: Pass several paths in one call — directories are listed, files are read. E.g. \`${withArgs} ${examples.join(" ")}\`.\n`;
}

function displayExample(prefix: string, dir: string, file: string): string {
  return [prefix, dir, file].filter((part) => part.length > 0).join("/");
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

function detectPackageManager(cwd: string): PackageManagerCommands {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, "package-lock.json")))
      return { base: "npm run docmap", withArgs: "npm run docmap --" };
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return sameCommand("pnpm docmap");
    if (existsSync(join(dir, "yarn.lock"))) return sameCommand("yarn docmap");
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")))
      return sameCommand("bun run docmap");
    const parent = dirname(dir);
    if (parent === dir) return fallbackCommand();
    dir = parent;
  }
}

// No lockfile found: docmap is likely not wired as a project script, so a bare `docmap` would
// assume a global install. Suggest the package-runner form instead, picking the runner from the
// manager that launched this process (npm_config_user_agent) and defaulting to npx, which ships
// with every Node install.
function fallbackCommand(): PackageManagerCommands {
  const agent = process.env.npm_config_user_agent ?? "";
  if (agent.startsWith("pnpm")) return sameCommand("pnpm dlx @paleo/docmap");
  if (agent.startsWith("yarn")) return sameCommand("yarn dlx @paleo/docmap");
  if (agent.startsWith("bun")) return sameCommand("bunx @paleo/docmap");
  return sameCommand("npx @paleo/docmap");
}

// Only npm needs a `--` separator before forwarded args; every other manager passes them verbatim.
function sameCommand(command: string): PackageManagerCommands {
  return { base: command, withArgs: command };
}
