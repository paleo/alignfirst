import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type MainOptions, main, type PackageManagerCommands } from "../src/cli.js";
import { extractFallbackTitle } from "../src/parser.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const fixtures = {
  basic: resolve(__dirname, "fixtures/basic"),
  errors: resolve(__dirname, "fixtures/errors"),
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

function invoke(argv: string[], cwd: string, commands?: PackageManagerCommands) {
  return invokeWith({ argv, cwd, commands });
}

function invokeWith(options: Omit<MainOptions, "stdout" | "stderr">) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = main({
    ...options,
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
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("recursive-by-default for small sets (basic fixture)", () => {
  it("lists root files with their supplied titles and summaries", () => {
    const { code, stdout } = run([], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "code-style.md"));
    expect(stdout).toContain("Code Style");
    expect(stdout).toContain("Conventions and formatting rules for the codebase.");
    expect(stdout).toContain(dp(fixtures.basic, "getting-started.md"));
    expect(stdout).toContain("Getting Started");
  });

  it("recurses into subdirectories without a flag", () => {
    const { stdout } = run([], fixtures.basic);
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).toContain(dp(fixtures.basic, "frontend/components.md"));
  });
});

describe("top-level listing for large sets (large fixture)", () => {
  it("counts files recursively for the threshold: 20 docs nested under bulk/ still stay top-level", () => {
    const { code, stdout } = run([], fixtures.large);
    expect(code).toBe(0);
    expect(stdout).toContain("bulk/");
    expect(stdout).toContain("nested-a/");
    // Top-level mode does not descend into subdirs, so the nested docs are not expanded.
    expect(stdout).not.toContain(dp(fixtures.large, "bulk/doc-01.md"));
    expect(stdout).not.toContain(dp(fixtures.large, "nested-a/inner.md"));
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
    expect(stdout).toContain(dp(fixtures.basic, "code-style.md"));
    expect(stdout).toContain(dp(fixtures.basic, "getting-started.md"));
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).toContain(dp(fixtures.basic, "backend/database.md"));
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
  it("lists directories and reads files in the same invocation", () => {
    const { code, stdout } = run(["backend", "getting-started.md"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).toContain(`<document_file path="${dp(fixtures.basic, "getting-started.md")}">`);
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

  it("reads a non-markdown file verbatim, without stripping a leading `---` block", () => {
    const { code, stdout } = run(["config.yaml"], fixtures.listable);
    expect(code).toBe(0);
    expect(stdout).toContain(`<document_file path="${dp(fixtures.listable, "config.yaml")}">`);
    expect(stdout).toContain("---\nkey: value\n---\nother: value");
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
    expect(stdout).toContain('workspace "Example"');
  });
});

describe("env files and template suffixes (listable fixture)", () => {
  it("lists env templates but never a live secret env file", () => {
    const { stdout } = run(["--recursive"], fixtures.listable);
    expect(stdout).toContain(dp(fixtures.listable, ".env.example"));
    expect(stdout).toContain(dp(fixtures.listable, ".env.sample"));
    expect(stdout).toContain(dp(fixtures.listable, ".env.production.example"));
    expect(stdout).not.toContain(dp(fixtures.listable, ".env.local"));
  });

  it("refuses to read a live secret env file even by explicit path", () => {
    const secret = readFileSync(join(fixtures.listable, ".env.local"), "utf8");
    expect(secret).toBe("API_KEY=local\n");
    const { code, stdout } = run([".env.local"], fixtures.listable);
    expect(code).toBe(0);
    expect(stdout).not.toContain(secret.trimEnd());
    expect(stdout).not.toContain("<document_file");
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
  it.each(["bakcend", "nonexistent.md"])("reports the unresolved target %s", (target) => {
    const { code, stdout } = run([target], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(target);
    expect(stdout).not.toContain("<document_file");
    expect(stdout).not.toContain(dp(fixtures.basic, "getting-started.md"));
  });
});

describe("path traversal (basic fixture)", () => {
  it("refuses to list a directory reached via `..` outside the root", () => {
    const { code, stdout } = run(["../.."], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).not.toContain("fixtures/");
    expect(stdout).not.toContain("<document_file");
  });

  it("refuses to list an absolute directory outside the root", () => {
    const outside = resolve(fixtures.basic, "..");
    const { code, stdout } = run([outside], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).not.toContain("errors/");
    expect(stdout).not.toContain("<document_file");
  });
});

describe("unknown flags", () => {
  it("warns on stderr, skips the flag, and processes the rest", () => {
    const { code, stdout, stderr } = run(["--dir", "backend"], fixtures.basic);
    expect(code).toBe(0);
    expect(stderr).toContain("--dir");
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

describe("--check", () => {
  it("reports name issues and returns exit code 1", () => {
    const { code, stdout } = run(["--check"], fixtures.badNames);
    expect(code).toBe(1);
    expect(stdout).toContain("has space.md");
    expect(stdout).toContain("special(chars).md");
    expect(stdout).toContain("sub dir");
    expect(stdout).not.toContain("good-file.md");
  });

  it("returns exit code 0 when no issues", () => {
    const { code, stdout } = run(["--check"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("reports frontmatter issues", () => {
    const { code, stdout } = run(["--check"], fixtures.errors);
    expect(code).toBe(1);
    expect(stdout).toContain("unterminated-frontmatter.md");
    expect(stdout).toContain("missing-frontmatter.md");
    expect(stdout).not.toContain("missing-summary.md");
  });
});

describe("--root propagation", () => {
  // The `run` helper always passes `--root <fixture>`. Assertions target the propagated
  // `--root <value>` substring, which is independent of the package-manager prefix in front.
  const rooted = (sub: string) => `--root ${fixtures.basic} ${sub}`;

  it("propagates the selected root into suggested commands", () => {
    const { code, stdout } = run([], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(rooted("--recursive"));
    expect(stdout).toContain(rooted("--guide"));
  });

  it("folds the root into every command shown in the authoring guide", () => {
    const { stdout } = run(["--guide"], fixtures.basic);
    expect(stdout).toContain(rooted("--recursive"));
    expect(stdout).toContain(rooted("--check"));
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
    expect(stdout).toContain("The gateway forwards requests.");
    expect(stdout).toMatch(/\b7\b/);
  });

  it("adds no snippet when the match is metadata-only", () => {
    const { stdout } = run(["--search", "quarantine"], fixtures.search);
    expect(stdout).toContain(dp(fixtures.search, "meta-only.md"));
    expect(stdout).not.toContain("Follow the checklist.");
  });

  it("clips a long line around the matched term", () => {
    const { stdout } = run(["--search", "telemetry"], fixtures.search);
    expect(stdout).toContain("telemetry");
    expect(stdout).toMatch(/\b7\b/);
    expect(stdout).not.toContain("start-marker");
    expect(stdout).not.toContain("end-marker");
  });
});

describe("--search result cap (large fixture)", () => {
  it("caps results at the 20 highest-ranked documents", () => {
    const { code, stdout } = run(["--search", "doc"], fixtures.large);
    expect(code).toBe(0);
    expect(stdout.match(/bulk\/doc-\d+\.md/g)).toHaveLength(20);
    // The two summary-only matches score below the 20 path/title hits and are the ones dropped.
    expect(stdout).not.toContain(dp(fixtures.large, "nested-a/inner.md"));
    expect(stdout).not.toContain(dp(fixtures.large, "only-subs/deep/leaf.md"));
  });
});

describe("CHANGELOG file exclusion", () => {
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

  it("--check warns about missing title on no-heading.md", () => {
    const { code, stdout } = run(["--check"], fixtures.noFrontmatter);
    expect(code).toBe(1);
    expect(stdout).toContain("no-heading.md");
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

describe("invocation-aware CLI prefixes", () => {
  // Runner selection itself is covered in invocation.test.ts; these cases check the CLI wiring:
  // evidence reaches help and guide, the root is folded in, and lockfiles stay ignored.
  it.each([
    ["node", {}, "docmap"],
    ["bun", {}, "bunx --bun @alignfirst/docmap"],
    [
      "node",
      { npm_config_user_agent: "npm/12", npm_command: "exec", npm_lifecycle_event: "npx" },
      "npx -y @alignfirst/docmap",
    ],
  ] as const)("uses real %s evidence %j over conflicting lockfiles", (runtime, env, prefix) => {
    const cwd = mkdtempSync(join(tmpdir(), "docmap-invocation-"));
    try {
      for (const lock of ["package-lock.json", "bun.lock", "yarn.lock", "pnpm-lock.yaml"])
        writeFileSync(join(cwd, lock), "");
      for (const mode of ["--help", "--guide"]) {
        const { stdout } = invokeWith({
          argv: ["runtime", "docmap", mode, "--root", "docs' quoted\\path"],
          cwd,
          evidence: { runtime, env, cwd, executable: "/runtime" },
        });
        expect(stdout).toContain(`${prefix} --root 'docs'\\'' quoted\\path'`);
        expect(stdout).not.toContain("npm run docmap");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // `$&` would re-insert the placeholder if the guide used string replacement patterns.
  it.each(["docs", "docs$&"])(
    "retains verified npm script %s literally with its forwarding separator",
    (name) => {
      const cwd = mkdtempSync(join(tmpdir(), "docmap-script-"));
      try {
        const entryPoint = join(cwd, "docmap.mjs");
        const manifest = join(cwd, "package.json");
        const script = `node ${entryPoint}`;
        writeFileSync(entryPoint, "");
        writeFileSync(manifest, JSON.stringify({ scripts: { [name]: script } }));
        const evidence = {
          runtime: "node" as const,
          cwd,
          entryPoint,
          executable: process.execPath,
          parentArgv: ["/bin/sh", "-c", script],
          env: {
            npm_config_user_agent: "npm/12",
            npm_command: "run",
            npm_lifecycle_event: name,
            npm_lifecycle_script: script,
            npm_package_json: manifest,
          },
        };
        const renderedName = name === "docs" ? name : `'${name}'`;
        for (const mode of ["--help", "--guide"]) {
          const { stdout } = invokeWith({ argv: ["node", entryPoint, mode], evidence, cwd });
          expect(stdout).toContain(`npm run ${renderedName} -- --check`);
          expect(stdout).not.toContain("{{");
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});

describe("injected command prefix", () => {
  const commands = { base: "alignfirst docmap", withArgs: "alignfirst docmap" };

  it.each([[], ["--help"], ["--guide"]])("uses the enclosing CLI for %j", (...args) => {
    const { stdout } = invoke(["node", "docmap", ...args], "/", commands);
    expect(stdout).toContain("alignfirst docmap --recursive");
  });

  it("folds --root into the injected prefix", () => {
    const out = invoke(["node", "docmap", "--root", "my docs", "--help"], "/", commands).stdout;
    expect(out).toContain("alignfirst docmap --root 'my docs' --check");
  });
});
