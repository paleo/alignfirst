import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { extractFallbackTitle } from "../src/parser.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const fixtures = {
  basic: resolve(__dirname, "fixtures/basic"),
  errors: resolve(__dirname, "fixtures/errors"),
  empty: resolve(__dirname, "fixtures/empty"),
  subdirsOnly: resolve(__dirname, "fixtures/subdirs-only"),
  nested: resolve(__dirname, "fixtures/nested"),
  badNames: resolve(__dirname, "fixtures/bad-names"),
  noFrontmatter: resolve(__dirname, "fixtures/no-frontmatter"),
  classify: resolve(__dirname, "fixtures/classify"),
  large: resolve(__dirname, "fixtures/large"),
};

// The display prefix is the root relative to cwd; mirror it to build expected paths.
function dp(fixtureDir: string, rel: string) {
  return `${relative(process.cwd(), fixtureDir)}/${rel}`;
}

function run(args: string[], fixtureDir: string) {
  return invoke(["node", "docmap", "--root", fixtureDir, ...args], process.cwd());
}

function invoke(argv: string[], cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = main({
    argv,
    stdout: {
      write: (s) => {
        stdout.push(s);
      },
    },
    stderr: {
      write: (s) => {
        stderr.push(s);
      },
    },
    cwd,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("recursive-by-default for small sets (basic fixture)", () => {
  it("lists root files with titles and summaries, prefixed by short help", () => {
    const { code, stdout } = run([], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("--guide");
    expect(stdout).toContain("--search");
    expect(stdout).toContain(dp(fixtures.basic, "code-style.md"));
    expect(stdout).toContain("Code Style");
    expect(stdout).toContain("Conventions and formatting rules for the codebase.");
    expect(stdout).toContain(dp(fixtures.basic, "getting-started.md"));
    expect(stdout).toContain("Getting Started");
  });

  it("recurses into subdirectories without a flag", () => {
    const { stdout } = run([], fixtures.basic);
    expect(stdout).toContain("## `backend/`");
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).toContain("## `frontend/`");
    expect(stdout).toContain(dp(fixtures.basic, "frontend/components.md"));
    expect(stdout).not.toContain("## Sub-directories");
  });

  it("does not print short help for a positional directory", () => {
    const { stdout } = run(["backend"], fixtures.basic);
    expect(stdout).not.toContain("--guide");
  });
});

describe("top-level listing for large sets (large fixture)", () => {
  it("counts files recursively for the threshold: 20 docs nested under bulk/ still stay top-level", () => {
    const { code, stdout } = run([], fixtures.large);
    expect(code).toBe(0);
    expect(stdout).toContain("## Sub-directories");
    expect(stdout).toContain("- bulk/");
    expect(stdout).toContain("- nested-a/");
    // Top-level mode does not descend into subdirs, so the nested docs are not expanded.
    expect(stdout).not.toContain(dp(fixtures.large, "bulk/doc-01.md"));
    expect(stdout).not.toContain(dp(fixtures.large, "nested-a/inner.md"));
  });

  it("does not prefix the listing with short help", () => {
    const { stdout } = run([], fixtures.large);
    expect(stdout).not.toContain("--guide");
  });
});

describe("positional directory listing (basic fixture)", () => {
  it("lists only backend files", () => {
    const { code, stdout } = run(["backend"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("`backend/`");
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).toContain(dp(fixtures.basic, "backend/database.md"));
    expect(stdout).not.toContain(dp(fixtures.basic, "getting-started.md"));
  });

  it("lists multiple dirs", () => {
    const { code, stdout } = run(["backend", "frontend"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).toContain(dp(fixtures.basic, "frontend/components.md"));
  });

  it("accepts the root prefix and a trailing slash", () => {
    const { code, stdout } = run([`${dp(fixtures.basic, "backend")}/`], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("`backend/`");
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
  });
});

describe("--recursive (basic fixture)", () => {
  it("lists all files across all directories", () => {
    const { code, stdout } = run(["--recursive"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("# Documentation");
    expect(stdout).toContain(dp(fixtures.basic, "code-style.md"));
    expect(stdout).toContain(dp(fixtures.basic, "getting-started.md"));
    expect(stdout).toContain("## `backend/`");
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).toContain(dp(fixtures.basic, "backend/database.md"));
    expect(stdout).toContain("## `frontend/`");
    expect(stdout).toContain(dp(fixtures.basic, "frontend/components.md"));
  });

  it("recursive from a positional dir", () => {
    const { code, stdout } = run(["backend", "--recursive"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).toContain(dp(fixtures.basic, "backend/database.md"));
    expect(stdout).not.toContain("frontend");
  });
});

describe("positional file read (basic fixture)", () => {
  it("reads a file and strips frontmatter", () => {
    const { code, stdout } = run(["getting-started.md"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(`<document_file path="${dp(fixtures.basic, "getting-started.md")}">`);
    expect(stdout).toContain("# Getting Started");
    expect(stdout).toContain("</document_file>");
    expect(stdout).not.toContain("summary:");
  });

  it("reads a file given with the root prefix", () => {
    const { code, stdout } = run([dp(fixtures.basic, "getting-started.md")], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(`<document_file path="${dp(fixtures.basic, "getting-started.md")}">`);
    expect(stdout).toContain("# Getting Started");
  });

  it("reads multiple files", () => {
    const { code, stdout } = run(
      [dp(fixtures.basic, "getting-started.md"), dp(fixtures.basic, "code-style.md")],
      fixtures.basic,
    );
    expect(code).toBe(0);
    expect(stdout).toContain(`<document_file path="${dp(fixtures.basic, "getting-started.md")}">`);
    expect(stdout).toContain(`<document_file path="${dp(fixtures.basic, "code-style.md")}">`);
  });

  it("fuzzy search finds files recursively by basename", () => {
    const { code, stdout } = run(["database.md"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(`<document_file path="${dp(fixtures.basic, "backend/database.md")}">`);
    expect(stdout).toContain("# Database Guide");
  });
});

describe("mixed positionals (basic fixture)", () => {
  it("lists directories before reading files", () => {
    const { code, stdout } = run(["backend", "getting-started.md"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).toContain(`<document_file path="${dp(fixtures.basic, "getting-started.md")}">`);
    const listIdx = stdout.indexOf(dp(fixtures.basic, "backend/api-guide.md"));
    const readIdx = stdout.indexOf(
      `<document_file path="${dp(fixtures.basic, "getting-started.md")}">`,
    );
    expect(listIdx).toBeLessThan(readIdx);
  });

  it("file read combined with --recursive shows listing and document", () => {
    const { code, stdout } = run(["code-style.md", "--recursive"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).toContain(dp(fixtures.basic, "frontend/components.md"));
    expect(stdout).toContain(`<document_file path="${dp(fixtures.basic, "code-style.md")}">`);
  });
});

describe("stat-driven classification (classify fixture)", () => {
  it("reads a non-.md file given by exact path", () => {
    const { code, stdout } = run(["notes.txt"], fixtures.classify);
    expect(code).toBe(0);
    expect(stdout).toContain(`<document_file path="${dp(fixtures.classify, "notes.txt")}">`);
    expect(stdout).toContain("# Plain Notes");
  });

  it("reads an extensionless file given by exact path", () => {
    const { code, stdout } = run(["LICENSE"], fixtures.classify);
    expect(code).toBe(0);
    expect(stdout).toContain(`<document_file path="${dp(fixtures.classify, "LICENSE")}">`);
    expect(stdout).toContain("# License");
  });

  it("lists a directory whose name contains a dot (not read)", () => {
    const { code, stdout } = run(["v1.2"], fixtures.classify);
    expect(code).toBe(0);
    expect(stdout).toContain("`v1.2/`");
    expect(stdout).toContain(dp(fixtures.classify, "v1.2/guide.md"));
    expect(stdout).not.toContain("<document_file");
  });
});

describe("not-found classification (basic fixture)", () => {
  it("reports a mistyped directory without a silent empty listing", () => {
    const { code, stdout } = run(["bakcend"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("⚠ Not found: bakcend");
    expect(stdout).not.toContain("<document_file");
    expect(stdout).not.toContain("# `bakcend/`");
  });

  it("reports an absent file with the same generic line", () => {
    const { code, stdout } = run(["nonexistent.md"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("⚠ Not found: nonexistent.md");
    expect(stdout).not.toContain("<document_file");
  });
});

describe("path traversal (basic fixture)", () => {
  it("refuses to list a directory reached via `..` outside the root", () => {
    const { code, stdout } = run(["../.."], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("⚠ Not found: ../..");
    expect(stdout).not.toContain("# `");
    expect(stdout).not.toContain("<document_file");
  });

  it("refuses to list an absolute directory outside the root", () => {
    const outside = resolve(fixtures.basic, "..");
    const { code, stdout } = run([outside], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(`⚠ Not found: ${outside}`);
    expect(stdout).not.toContain("<document_file");
  });
});

describe("unknown flags", () => {
  it("warns on stderr, skips the flag, and processes the rest", () => {
    const { code, stdout, stderr } = run(["--dir", "backend"], fixtures.basic);
    expect(code).toBe(0);
    expect(stderr).toContain("Unknown option: --dir (ignored)");
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).not.toContain("--dir");
  });
});

describe("display prefix", () => {
  it("uses bare paths when the root resolves to the working directory", () => {
    const { code, stdout } = invoke(
      ["node", "docmap", "--root", ".", "getting-started.md"],
      fixtures.basic,
    );
    expect(code).toBe(0);
    expect(stdout).toContain('<document_file path="getting-started.md">');
  });
});

describe("error fixtures", () => {
  it("shows missing-frontmatter.md without warning", () => {
    const { stdout } = run([], fixtures.errors);
    expect(stdout).toContain("missing-frontmatter.md");
    expect(stdout).not.toContain("⚠ Missing frontmatter");
  });

  it("shows unterminated frontmatter warning", () => {
    const { stdout } = run([], fixtures.errors);
    expect(stdout).toContain("⚠ Unterminated frontmatter");
  });

  it("lists missing-summary.md without warning", () => {
    const { stdout } = run([], fixtures.errors);
    expect(stdout).toContain(dp(fixtures.errors, "missing-summary.md"));
    expect(stdout).toContain("Missing Summary Doc");
    expect(stdout).not.toContain("Missing 'summary'");
  });
});

describe("empty fixture", () => {
  it("shows no files", () => {
    const { code, stdout } = run([], fixtures.empty);
    expect(code).toBe(0);
    // Only the short help prints; no listing bullets follow.
    expect(stdout).not.toMatch(/^- /m);
  });
});

describe("nested fixture with --recursive", () => {
  it("produces correct heading levels for deep nesting", () => {
    const { code, stdout } = run(["--recursive"], fixtures.nested);
    expect(code).toBe(0);
    expect(stdout).toContain("# Documentation");
    expect(stdout).toContain(dp(fixtures.nested, "top-level.md"));
    expect(stdout).toContain("## `level-one/`");
    expect(stdout).toContain(dp(fixtures.nested, "level-one/doc-a.md"));
    expect(stdout).toContain("### `level-two/`");
    expect(stdout).toContain(dp(fixtures.nested, "level-one/level-two/deep-doc.md"));
  });
});

describe("name validation", () => {
  it("shows warning for files with spaces", () => {
    const { stdout } = run([], fixtures.badNames);
    expect(stdout).toContain("has space.md");
    expect(stdout).toContain("⚠ Name contains spaces or special characters");
  });

  it("shows warning for files with special characters", () => {
    const { stdout } = run([], fixtures.badNames);
    expect(stdout).toContain("special(chars).md");
    expect(stdout).toContain("⚠ Name contains spaces or special characters");
  });

  it("shows no warning for good file names", () => {
    const { stdout } = run([], fixtures.badNames);
    const lines = stdout.split("\n");
    const goodLine = lines.findIndex((l: string) => l.includes("good-file.md"));
    expect(goodLine).toBeGreaterThan(-1);
    const nextLine = lines[goodLine + 1];
    expect(nextLine).not.toContain("⚠ Name contains");
  });

  it("shows warning for directories with bad names", () => {
    const { stdout } = run([], fixtures.badNames);
    expect(stdout).toContain("sub dir/");
    expect(stdout).toContain("⚠ Name contains spaces or special characters");
  });
});

describe("--check", () => {
  it("reports name issues and returns exit code 1", () => {
    const { code, stdout } = run(["--check"], fixtures.badNames);
    expect(code).toBe(1);
    expect(stdout).toContain("Name contains spaces or special characters");
  });

  it("returns exit code 0 when no issues", () => {
    const { code, stdout } = run(["--check"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("reports frontmatter issues", () => {
    const { code, stdout } = run(["--check"], fixtures.errors);
    expect(code).toBe(1);
    expect(stdout).not.toContain("Missing frontmatter");
    expect(stdout).toContain("Unterminated frontmatter");
    expect(stdout).not.toContain("Missing 'summary'");
  });
});

describe("--help", () => {
  it("prints full help with the extra-option markers and no listing", () => {
    const { code, stdout } = run(["--help"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("--guide");
    expect(stdout).toContain("--search");
    expect(stdout).toContain("--check");
    expect(stdout).not.toContain("# Documentation");
    expect(stdout).not.toContain(dp(fixtures.basic, "code-style.md"));
    expect(stdout).not.toContain("<document_file");
  });

  it("groups --search under Commands, above the More section", () => {
    const { stdout } = run(["--help"], fixtures.basic);
    expect(stdout.indexOf("--search")).toBeLessThan(stdout.indexOf("More:"));
  });

  it("aligns the inline comments within a command group", () => {
    const { stdout } = run(["--help"], fixtures.basic);
    const lines = stdout.split("\n");
    // Commands render inside a ``` fence; collect the command lines between the fences.
    const fence = lines.indexOf("```", lines.indexOf("Commands:"));
    const columns: number[] = [];
    for (let i = fence + 1; i < lines.length && lines[i] !== "```"; ++i) {
      columns.push(lines[i].indexOf(" # "));
    }
    // Every command line in the group shares one comment column.
    expect(columns.length).toBeGreaterThan(1);
    expect(new Set(columns).size).toBe(1);
  });
});

describe("--guide", () => {
  it("prints the authoring guide and no listing", () => {
    const { code, stdout } = run(["--guide"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("# Authoring Documentation");
    expect(stdout).toContain("YAML Frontmatter");
    expect(stdout).not.toContain("# Documentation");
    expect(stdout).not.toContain(dp(fixtures.basic, "code-style.md"));
    expect(stdout).not.toContain("<document_file");
  });
});

describe("--search", () => {
  it("matches a single term against frontmatter", () => {
    const { code, stdout } = run(["--search", "database"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "backend/database.md"));
    expect(stdout).not.toContain(dp(fixtures.basic, "code-style.md"));
    expect(stdout).not.toContain(dp(fixtures.basic, "backend/api-guide.md"));
  });

  it("requires every term to match (AND) and excludes non-matching files", () => {
    const { code, stdout } = run(["--search", "guide api"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).not.toContain(dp(fixtures.basic, "backend/database.md"));
  });

  it("matches the file basename even when absent from frontmatter", () => {
    const { code, stdout } = run(["--search", "code-style"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "code-style.md"));
    expect(stdout).not.toContain(dp(fixtures.basic, "getting-started.md"));
  });

  it("matches a directory segment of the path", () => {
    const { code, stdout } = run(["--search", "backend"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "backend/database.md"));
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).not.toContain(dp(fixtures.basic, "code-style.md"));
  });

  it("reports when nothing matches", () => {
    const { code, stdout } = run(["--search", "zzznomatch"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("No documents match: zzznomatch");
  });
});

describe("CHANGELOG file exclusion", () => {
  it("does not list CHANGELOG.md in default listing", () => {
    const { stdout } = run([], fixtures.basic);
    expect(stdout).not.toContain("CHANGELOG");
  });

  it("does not list CHANGELOG.md in recursive listing", () => {
    const { stdout } = run(["--recursive"], fixtures.basic);
    expect(stdout).not.toContain("CHANGELOG");
  });

  it("does not surface CHANGELOG.md in --check", () => {
    const { stdout } = run(["--check"], fixtures.basic);
    expect(stdout).not.toContain("CHANGELOG");
  });
});

describe("no-frontmatter fixture", () => {
  it("shows heading-first.md with its heading as title", () => {
    const { stdout } = run([], fixtures.noFrontmatter);
    expect(stdout).toContain("My Title");
  });

  it("shows prelude.md with its heading as title", () => {
    const { stdout } = run([], fixtures.noFrontmatter);
    expect(stdout).toContain("Actual Title");
  });

  it("shows code-block-trap.md with the real title, not the one inside the code block", () => {
    const { stdout } = run([], fixtures.noFrontmatter);
    expect(stdout).toContain("Real Title");
    const lines = stdout.split("\n");
    const trapLine = lines.find((l: string) => l.includes("code-block-trap.md"));
    expect(trapLine).not.toContain("not a title");
  });

  it("shows no-heading.md without a title and without a warning", () => {
    const { stdout } = run([], fixtures.noFrontmatter);
    expect(stdout).toContain("no-heading.md");
    const lines = stdout.split("\n");
    const noHeadingLine = lines.findIndex((l: string) => l.includes("no-heading.md"));
    expect(noHeadingLine).toBeGreaterThan(-1);
    const nextLine = lines[noHeadingLine + 1];
    expect(nextLine).not.toContain("⚠");
  });

  it("--check warns about missing title on no-heading.md", () => {
    const { code, stdout } = run(["--check"], fixtures.noFrontmatter);
    expect(code).toBe(1);
    expect(stdout).toContain("no-heading.md");
    expect(stdout).toContain("Missing title");
  });
});

describe("extractFallbackTitle", () => {
  it("returns the heading from a simple document", () => {
    expect(extractFallbackTitle("# Simple Title\n\nBody text")).toBe("Simple Title");
  });

  it("returns the heading when preceded by a text prelude", () => {
    expect(extractFallbackTitle("Some text\n\n# Heading After Prelude\n\nBody")).toBe(
      "Heading After Prelude",
    );
  });

  it("skips headings inside backtick fenced code blocks", () => {
    const content = "```bash\n# not a title\n```\n\n# Real Title";
    expect(extractFallbackTitle(content)).toBe("Real Title");
  });

  it("skips headings inside 4-backtick fenced code blocks", () => {
    const content = "````\n# not a title\n````\n\n# Real Title";
    expect(extractFallbackTitle(content)).toBe("Real Title");
  });

  it("skips headings inside tilde fenced code blocks", () => {
    const content = "~~~\n# not a title\n~~~\n\n# Real Title";
    expect(extractFallbackTitle(content)).toBe("Real Title");
  });

  it("returns undefined when there is no heading", () => {
    expect(extractFallbackTitle("Just some text\nwithout any heading")).toBeUndefined();
  });
});
