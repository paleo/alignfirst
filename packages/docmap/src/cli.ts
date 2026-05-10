import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  checkAll,
  collectAllFiles,
  formatDirectory,
  formatRecursive,
  listDirectory,
  readDocFile,
  type FormatResult,
} from "./formatter.js";

export interface MainOptions {
  argv?: string[];
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  cwd?: string;
}

export function main(options?: MainOptions): number {
  const argv = options?.argv ?? process.argv;
  const stdout = options?.stdout ?? process.stdout;
  const cwd = options?.cwd ?? process.cwd();

  const { dirs, recursive, read, root, check } = parseArgs(argv);

  const baseDir = root ? resolve(cwd, root) : resolve(cwd, "docs");

  if (check) {
    const issues = checkAll(baseDir, "");
    for (const issue of issues) {
      stdout.write(`${issue.path}: ${issue.message}\n`);
    }
    return issues.length > 0 ? 1 : 0;
  }

  const needsListing = dirs.length > 0 || recursive || !read;

  if (needsListing) {
    const targets =
      dirs.length > 0
        ? dirs.map((dir) => ({
            targetDir: resolve(baseDir, dir),
            rootTitle: `${dir}/`,
            rootRelDir: dir,
          }))
        : [{ targetDir: baseDir, rootTitle: "Documentation", rootRelDir: "" }];

    const allLines: string[] = [];
    let anySubdirList = false;
    let anyFiles = false;
    for (const { targetDir, rootTitle, rootRelDir } of targets) {
      let formatted: FormatResult;
      if (!recursive) {
        const result = listDirectory(targetDir);
        formatted = formatDirectory(targetDir, rootTitle, result, rootRelDir);
      } else {
        formatted = formatRecursive(targetDir, rootTitle, 1, rootRelDir);
      }
      allLines.push(...formatted.lines);
      if (formatted.hasSubdirList) anySubdirList = true;
      if (formatted.hasFiles) anyFiles = true;
    }

    stdout.write(`${allLines.join("\n")}\n`);
    const pm = detectPackageManager(cwd);
    if (anySubdirList) {
      stdout.write(
        `Tip: Use \`${pm} --dir topic-a --dir topic-b/sub-topic-c\` to list the subdirectories you need.\n`,
      );
    }
    if (anyFiles) {
      stdout.write(
        `Tip: Use \`${pm} --read docs/topic-a/doc-1.md --read docs/topic-b/doc-2.md\` to read the specified files (repeat \`--read\` for each file).\n`,
      );
    }
  }

  if (read) {
    if (needsListing) stdout.write("\n");
    let cachedFiles: string[] | undefined;
    const getAllFiles = (): string[] => (cachedFiles ??= collectAllFiles(baseDir, ""));
    const results = read.map((fileArg) => readDocFile(baseDir, fileArg, getAllFiles));
    const output = results
      .map(
        ({ path, content }) =>
          `<document_file path="${path}">\n${content.trimEnd()}\n</document_file>`,
      )
      .join("\n\n");
    stdout.write(`${output}\n`);
  }

  return 0;
}

export interface ParsedArgs {
  dirs: string[];
  recursive: boolean;
  read: string[] | undefined;
  root: string | undefined;
  check: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const dirs: string[] = [];
  let recursive = false;
  let read: string[] | undefined;
  let root: string | undefined;
  let check = false;

  for (let i = 0; i < args.length; ++i) {
    if (args[i] === "--dir" && i + 1 < args.length) {
      dirs.push(args[++i]);
    } else if (args[i] === "--recursive") {
      recursive = true;
    } else if (args[i] === "--check") {
      check = true;
    } else if (args[i] === "--read" && i + 1 < args.length) {
      read ??= [];
      read.push(args[++i]);
    } else if (args[i] === "--root" && i + 1 < args.length) {
      root = args[++i];
    }
  }

  for (let i = 0; i < dirs.length; ++i) {
    dirs[i] = dirs[i].replace(/\/+$/, "");
    if (dirs[i] === "docs" || dirs[i].startsWith("docs/"))
      dirs[i] = dirs[i].slice("docs".length).replace(/^\/+/, "");
  }

  return { dirs, recursive, read, root, check };
}

function detectPackageManager(cwd: string): string {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, "package-lock.json"))) return "npm run docmap --";
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm docmap";
    if (existsSync(join(dir, "yarn.lock"))) return "yarn docmap";
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")))
      return "bun run docmap";
    const parent = dirname(dir);
    if (parent === dir) return "npx docmap";
    dir = parent;
  }
}
