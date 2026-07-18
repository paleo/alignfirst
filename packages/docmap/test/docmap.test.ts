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
  emptySubdirs: resolve(__dirname, "fixtures/empty-subdirs"),
  subdirsOnly: resolve(__dirname, "fixtures/subdirs-only"),
  nested: resolve(__dirname, "fixtures/nested"),
  badNames: resolve(__dirname, "fixtures/bad-names"),
  noFrontmatter: resolve(__dirname, "fixtures/no-frontmatter"),
  classify: resolve(__dirname, "fixtures/classify"),
  large: resolve(__dirname, "fixtures/large"),
  listable: resolve(__dirname, "fixtures/listable"),
  search: resolve(__dirname, "fixtures/search"),
};

// The display prefix is the root relative to cwd; mirror it to build expected paths.
function dp(fixtureDir: string, rel: string) {
  return `${relative(process.cwd(), fixtureDir)}/${rel}`;
}

function run(args: string[], fixtureDir: string) {
  return invoke(["node", "docmap", "--root", fixtureDir, ...args], process.cwd());
}

function invoke(argv: string[], cwd: string, userAgent?: string) {
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
    userAgent,
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

  it("still prefixes the listing with short help", () => {
    const { stdout } = run([], fixtures.large);
    expect(stdout).toContain("--guide");
    expect(stdout).toContain("--search");
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

describe("listable extensions (listable fixture)", () => {
  it("lists text, diagram, data, and schema files alongside markdown", () => {
    const { code, stdout } = run(["--recursive"], fixtures.listable);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.listable, "readme.md"));
    expect(stdout).toContain(dp(fixtures.listable, "schema.sql"));
    expect(stdout).toContain(dp(fixtures.listable, "config.yaml"));
    expect(stdout).toContain(dp(fixtures.listable, "diagrams/c4-model.dsl"));
  });

  it("excludes binary and hard-to-read formats from listings", () => {
    const { stdout } = run(["--recursive"], fixtures.listable);
    expect(stdout).not.toContain("report.pdf");
    expect(stdout).not.toContain("image.png");
  });

  it("shows a non-markdown file as a bare path with no title", () => {
    const { stdout } = run(["--recursive"], fixtures.listable);
    const dsl = dp(fixtures.listable, "diagrams/c4-model.dsl");
    expect(stdout).toContain(`- \`${dsl}\`\n`);
  });

  it("reads a non-markdown file verbatim, without stripping a leading `---`", () => {
    const { code, stdout } = run(["c4-model.dsl"], fixtures.listable);
    expect(code).toBe(0);
    expect(stdout).toContain(
      `<document_file path="${dp(fixtures.listable, "diagrams/c4-model.dsl")}">`,
    );
    expect(stdout).toContain('workspace "Example"');
  });

  it("does not flag missing frontmatter or title on non-markdown files under --check", () => {
    const { code, stdout } = run(["--check"], fixtures.listable);
    expect(code).toBe(0);
    expect(stdout).not.toContain("schema.sql");
    expect(stdout).not.toContain("c4-model.dsl");
    expect(stdout).not.toContain("config.yaml");
  });

  it("resolves a non-markdown file by fuzzy basename search", () => {
    const { code, stdout } = run(["c4-model.dsl"], fixtures.listable);
    expect(code).toBe(0);
    expect(stdout).toContain(
      `<document_file path="${dp(fixtures.listable, "diagrams/c4-model.dsl")}">`,
    );
  });
});

describe("env files and template suffixes (listable fixture)", () => {
  it("lists env templates but never a live secret env file", () => {
    const { stdout } = run(["--recursive"], fixtures.listable);
    expect(stdout).toContain(dp(fixtures.listable, ".env.example"));
    expect(stdout).toContain(dp(fixtures.listable, ".env.sample"));
    expect(stdout).toContain(dp(fixtures.listable, ".env.production.example"));
    expect(stdout).not.toContain(dp(fixtures.listable, ".env.local"));
    expect(stdout).not.toContain(`${dp(fixtures.listable, ".env")}\``);
  });

  it("refuses to read a live secret env file even by explicit path", () => {
    const { code, stdout } = run([".env"], fixtures.listable);
    expect(code).toBe(0);
    expect(stdout).not.toContain("<document_file");
    expect(stdout).toContain("⚠ Not found: .env");
  });

  it("lists a template on the format underneath its suffix", () => {
    const { stdout } = run(["--recursive"], fixtures.listable);
    expect(stdout).toContain(dp(fixtures.listable, "config.yaml.example"));
  });

  it("reads an env template verbatim", () => {
    const { code, stdout } = run([".env.example"], fixtures.listable);
    expect(code).toBe(0);
    expect(stdout).toContain(`<document_file path="${dp(fixtures.listable, ".env.example")}">`);
    expect(stdout).toContain("DATABASE_URL=");
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
  it("keeps the title and appends an explicit empty note, with no bullets", () => {
    const { code, stdout } = run([], fixtures.empty);
    expect(code).toBe(0);
    expect(stdout).toContain("# Documentation");
    expect(stdout).toContain("_No documents here._");
    expect(stdout).not.toMatch(/^- /m);
  });
});

describe("recursive listing over empty sub-directories", () => {
  it("emits the sub-dir headings without the empty note", () => {
    const { code, stdout } = run(["--recursive"], fixtures.emptySubdirs);
    expect(code).toBe(0);
    expect(stdout).toContain("## `topic-a/`");
    expect(stdout).not.toContain("_No documents here._");
  });
});

describe("missing root folder", () => {
  const missing = resolve(__dirname, "fixtures/does-not-exist");

  it("shows an explicit message instead of the title", () => {
    const { code, stdout } = run([], missing);
    expect(code).toBe(0);
    expect(stdout).toContain("No documentation folder at");
    expect(stdout).toContain(`${relative(process.cwd(), missing)}/`);
    expect(stdout).not.toContain("# Documentation");
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

describe("--root propagation", () => {
  // The `run` helper always passes `--root <fixture>`. Assertions target the propagated
  // `--root <value>` substring, which is independent of the package-manager prefix in front.
  const rooted = (sub: string) => `--root ${fixtures.basic} ${sub}`;

  it("still renders the short help of a bare invocation and folds the root into every command", () => {
    const { code, stdout } = run([], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain(rooted("--recursive"));
    expect(stdout).toContain(rooted('--search "term1 term2"'));
    // The "Before writing…" line carries it too.
    expect(stdout).toContain(rooted("--guide"));
  });

  it("folds the root into every command shown in the authoring guide", () => {
    const { stdout } = run(["--guide"], fixtures.basic);
    expect(stdout).toContain(rooted("--recursive"));
    expect(stdout).toContain(rooted("--check"));
  });

  it("drops the standalone `--root <path>` help row once a root is active", () => {
    const { stdout } = run(["--help"], fixtures.basic);
    expect(stdout).not.toContain("--root <path>");
    expect(stdout).toContain(rooted("--check"));
  });

  it("documents `--root <path>` in full help when no root is given", () => {
    const { stdout } = invoke(["node", "docmap", "--help"], process.cwd());
    expect(stdout).toContain("--root <path>");
  });

  it("is accepted alongside a bare invocation without counting as a positional", () => {
    const { code, stdout } = run([], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("# Documentation");
    expect(stdout).toContain(dp(fixtures.basic, "getting-started.md"));
  });

  it("quotes a root with spaces so the folded command stays copy-pasteable", () => {
    const { stdout } = invoke(["node", "docmap", "--root", "my docs", "--help"], process.cwd());
    expect(stdout).toContain("--root 'my docs'");
    expect(stdout).not.toContain("--root my docs");
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

  it("matches any term (OR) and ranks the file matching more terms first", () => {
    const { code, stdout } = run(["--search", "guide api"], fixtures.basic);
    expect(code).toBe(0);
    const twoTerms = stdout.indexOf(dp(fixtures.basic, "backend/api-guide.md"));
    const oneTerm = stdout.indexOf(dp(fixtures.basic, "backend/database.md"));
    expect(twoTerms).toBeGreaterThan(-1);
    expect(oneTerm).toBeGreaterThan(-1);
    expect(twoTerms).toBeLessThan(oneTerm);
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

describe("--search ranking (search fixture)", () => {
  function searchOrder(query: string, first: string, second: string) {
    const { code, stdout } = run(["--search", query], fixtures.search);
    expect(code).toBe(0);
    const firstIdx = stdout.indexOf(dp(fixtures.search, first));
    const secondIdx = stdout.indexOf(dp(fixtures.search, second));
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
  }

  it("matches an accented title with an unaccented query", () => {
    const { stdout } = run(["--search", "specification"], fixtures.search);
    expect(stdout).toContain(dp(fixtures.search, "accent.md"));
  });

  it("matches plain text with an accented query", () => {
    const { stdout } = run(["--search", "spécification"], fixtures.search);
    expect(stdout).toContain(dp(fixtures.search, "plain.md"));
  });

  it("folds English plurals: 'workspaces' finds 'workspace'", () => {
    const { stdout } = run(["--search", "workspaces"], fixtures.search);
    expect(stdout).toContain(dp(fixtures.search, "workspace.md"));
  });

  it("folds French plurals in both directions", () => {
    expect(run(["--search", "cheval"], fixtures.search).stdout).toContain(
      dp(fixtures.search, "elevage.md"),
    );
    expect(run(["--search", "chevaux"], fixtures.search).stdout).toContain(
      dp(fixtures.search, "elevage.md"),
    );
  });

  it("matches plural-only documents with singular queries", () => {
    const { stdout } = run(["--search", "cache"], fixtures.search);
    expect(stdout).toContain(dp(fixtures.search, "plurals.md"));
    expect(run(["--search", "dependency"], fixtures.search).stdout).toContain(
      dp(fixtures.search, "plurals.md"),
    );
  });

  it("matches singular-only documents with plural queries", () => {
    const { stdout } = run(["--search", "branches"], fixtures.search);
    expect(stdout).toContain(dp(fixtures.search, "singulars.md"));
    expect(run(["--search", "dependencies"], fixtures.search).stdout).toContain(
      dp(fixtures.search, "singulars.md"),
    );
  });

  it("bridges irregular pairs in both directions", () => {
    expect(run(["--search", "index"], fixtures.search).stdout).toContain(
      dp(fixtures.search, "plurals.md"),
    );
    expect(run(["--search", "indices"], fixtures.search).stdout).toContain(
      dp(fixtures.search, "singulars.md"),
    );
  });

  it("bridges French irregular pairs across the œ ligature", () => {
    expect(run(["--search", "yeux"], fixtures.search).stdout).toContain(
      dp(fixtures.search, "ciel.md"),
    );
    expect(run(["--search", "cieux"], fixtures.search).stdout).toContain(
      dp(fixtures.search, "ciel.md"),
    );
  });

  it("ranks a title hit above a body-only hit", () => {
    searchOrder("gateway", "gateway.md", "notes.md");
  });

  it("caps occurrences: body spam does not outrank a title hit", () => {
    searchOrder("gateway", "gateway.md", "spam.md");
  });

  it("gives a word-boundary bonus over substring-only matches", () => {
    searchOrder("log", "log.md", "logging.md");
  });

  it("drops stopwords from the query instead of broadening results", () => {
    const { stdout } = run(["--search", "gateway the"], fixtures.search);
    expect(stdout).not.toContain(dp(fixtures.search, "plain.md"));
    // With "the" dropped, notes.md ("The gateway…") counts one term, not two, and stays behind.
    const gateway = stdout.indexOf(dp(fixtures.search, "gateway.md"));
    const notes = stdout.indexOf(dp(fixtures.search, "notes.md"));
    expect(gateway).toBeGreaterThan(-1);
    expect(gateway).toBeLessThan(notes);
  });

  it("keeps an all-stopwords query (safety valve)", () => {
    const { stdout } = run(["--search", "the"], fixtures.search);
    expect(stdout).toContain(dp(fixtures.search, "plain.md"));
  });

  it("breaks ties deterministically by path", () => {
    searchOrder("shared", "tie-a.md", "tie-b.md");
  });
});

describe("--search snippets (search fixture)", () => {
  it("shows the best matching body line with its raw-file line number", () => {
    const { code, stdout } = run(["--search", "forwards"], fixtures.search);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.search, "notes.md"));
    expect(stdout).toContain("  > 7: The gateway forwards requests.");
  });

  it("adds no snippet when the match is metadata-only", () => {
    const { stdout } = run(["--search", "quarantine"], fixtures.search);
    expect(stdout).toContain(dp(fixtures.search, "meta-only.md"));
    expect(stdout).not.toContain("  > ");
  });

  it("clips a long line around the matched term", () => {
    const { stdout } = run(["--search", "telemetry"], fixtures.search);
    const snippet = stdout.split("\n").find((line) => line.startsWith("  > "));
    expect(snippet).toBeDefined();
    expect(snippet).toContain("> 7:");
    expect(snippet).toContain("telemetry");
    expect(snippet).toContain("…");
    expect(snippet).not.toContain("start-marker");
    expect(snippet).not.toContain("end-marker");
  });
});

describe("--search result cap (large fixture)", () => {
  it("caps output at 20 bullets and reports the remainder", () => {
    const { code, stdout } = run(["--search", "doc"], fixtures.large);
    expect(code).toBe(0);
    const bullets = stdout.split("\n").filter((line) => line.startsWith("- `"));
    expect(bullets).toHaveLength(20);
    expect(stdout).toContain("… and 2 more matches");
    // The two summary-only matches score below the 20 path/title hits and are the ones dropped.
    expect(stdout).not.toContain(dp(fixtures.large, "nested-a/inner.md"));
    expect(stdout).not.toContain(dp(fixtures.large, "only-subs/deep/leaf.md"));
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

describe("package-manager prefix in help", () => {
  // Walk from "/" so no lockfile is found and detection falls through to the invocation-based
  // fallback. `--help` returns before any listing, so no `--root` is needed (and omitting it keeps
  // the suggested commands free of a folded-in root that would sit between prefix and `--guide`).
  function help(userAgent: string | undefined) {
    return invoke(["node", "docmap", "--help"], "/", userAgent).stdout;
  }

  it("suggests the bare global binary when no runner agent is set", () => {
    const out = help("");
    expect(out).toContain("docmap --guide");
    expect(out).not.toContain("npx @paleo/docmap");
    expect(out).not.toContain("npm run docmap");
  });

  it("keeps the npx suggestion when launched through npx, even if installed globally", () => {
    const out = help("npm/10.0.0 node/v24.0.0 linux x64 workspaces/false");
    expect(out).toContain("npx @paleo/docmap --guide");
  });

  it("suggests pnpm dlx under a pnpm runner", () => {
    expect(help("pnpm/9.0.0 npm/? node/v24.0.0")).toContain("pnpm dlx @paleo/docmap");
  });

  it("suggests bunx under a bun runner", () => {
    expect(help("bun/1.1.0 npm/? node/v24.0.0")).toContain("bunx @paleo/docmap");
  });

  it("suggests the npm run script when launched via npm inside a lockfile'd project", () => {
    const out = invoke(
      ["node", "docmap", "--help"],
      process.cwd(),
      "npm/10.0.0 node/v24.0.0 linux x64",
    ).stdout;
    expect(out).toContain("npm run docmap");
  });

  it("suggests the bare binary even inside a lockfile'd project when run as a global binary", () => {
    const out = invoke(["node", "docmap", "--help"], process.cwd(), "").stdout;
    expect(out).toContain("docmap --guide");
    expect(out).not.toContain("npm run docmap");
    expect(out).not.toContain("npx @paleo/docmap");
  });
});
