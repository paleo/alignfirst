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
  it("lists root files with their supplied titles and summaries, recursing without a flag", () => {
    const { code, stdout } = run([], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "code-style.md"));
    expect(stdout).toContain("Code Style");
    expect(stdout).toContain("Conventions and formatting rules for the codebase.");
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
  it.each([
    [["backend"], ["backend/api-guide.md", "backend/database.md"]],
    [
      ["backend", "frontend"],
      ["backend/api-guide.md", "frontend/components.md"],
    ],
    [[`${dp(fixtures.basic, "backend")}/`], ["backend/api-guide.md"]],
  ])("lists %j and only what it holds", (args, listed) => {
    const { code, stdout } = run(args, fixtures.basic);
    expect(code).toBe(0);
    for (const rel of listed) expect(stdout).toContain(dp(fixtures.basic, rel));
    expect(stdout).not.toContain(dp(fixtures.basic, "getting-started.md"));
  });

  it("recurses from a positional dir with --recursive", () => {
    const { code, stdout } = run(["backend", "--recursive"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(dp(fixtures.basic, "backend/api-guide.md"));
    expect(stdout).toContain(dp(fixtures.basic, "backend/database.md"));
    expect(stdout).not.toContain("frontend");
  });
});

describe("positional file read", () => {
  it("reads a markdown file and strips its frontmatter", () => {
    const { code, stdout } = run(["getting-started.md"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(`<document_file path="${dp(fixtures.basic, "getting-started.md")}">`);
    expect(stdout).toContain("# Getting Started");
    expect(stdout).toContain("</document_file>");
    expect(stdout).not.toContain("summary:");
  });

  it.each([
    [[dp(fixtures.basic, "getting-started.md")], ["getting-started.md"]],
    [
      [dp(fixtures.basic, "getting-started.md"), dp(fixtures.basic, "code-style.md")],
      ["getting-started.md", "code-style.md"],
    ],
  ])("reads root-prefixed paths %j", (args, read) => {
    const { code, stdout } = run(args, fixtures.basic);
    expect(code).toBe(0);
    for (const rel of read) {
      expect(stdout).toContain(`<document_file path="${dp(fixtures.basic, rel)}">`);
    }
  });

  it.each([
    ["classify", "notes.txt", "notes.txt", "# Plain Notes"],
    ["classify", "LICENSE", "LICENSE", "# License"],
    ["basic", "database.md", "backend/database.md", "# Database Guide"],
    ["listable", "c4-model.dsl", "diagrams/c4-model.dsl", 'workspace "Example"'],
    ["listable", "config.yaml", "config.yaml", "---\nkey: value\n---\nother: value"],
    ["listable", ".env.example", ".env.example", "DATABASE_URL="],
  ] as const)("reads %s target %s verbatim as %s", (fixture, target, rel, content) => {
    const { code, stdout } = run([target], fixtures[fixture]);
    expect(code).toBe(0);
    expect(stdout).toContain(`<document_file path="${dp(fixtures[fixture], rel)}">`);
    expect(stdout).toContain(content);
  });

  it("lists a directory whose name contains a dot (not read)", () => {
    const { code, stdout } = run(["v1.2"], fixtures.classify);
    expect(code).toBe(0);
    expect(stdout).toContain("`v1.2/`");
    expect(stdout).toContain(dp(fixtures.classify, "v1.2/guide.md"));
    expect(stdout).not.toContain("<document_file");
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

describe("listable files (listable fixture)", () => {
  it("lists allowlisted formats and env templates, never binaries or a live secret env file", () => {
    const { code, stdout } = run(["--recursive"], fixtures.listable);
    expect(code).toBe(0);
    const listed = [
      "readme.md",
      "schema.sql",
      "config.yaml",
      "diagrams/c4-model.dsl",
      ".env.example",
      ".env.production.example",
      "config.yaml.example",
    ];
    for (const rel of listed) expect(stdout).toContain(dp(fixtures.listable, rel));
    for (const rel of ["report.pdf", "image.png", ".env.local"]) {
      expect(stdout).not.toContain(dp(fixtures.listable, rel));
    }
  });

  it("refuses to read a live secret env file even by explicit path", () => {
    const secret = readFileSync(join(fixtures.listable, ".env.local"), "utf8");
    expect(secret).toBe("API_KEY=local\n");
    const { code, stdout } = run([".env.local"], fixtures.listable);
    expect(code).toBe(0);
    expect(stdout).not.toContain(secret.trimEnd());
    expect(stdout).not.toContain("<document_file");
  });

  it("does not flag missing frontmatter or title on non-markdown files under --check", () => {
    const { code, stdout } = run(["--check"], fixtures.listable);
    expect(code).toBe(0);
    expect(stdout).not.toContain("schema.sql");
    expect(stdout).not.toContain("c4-model.dsl");
    expect(stdout).not.toContain("config.yaml");
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
  it.each([
    ["a `..` path", "../..", "fixtures/"],
    ["an absolute path", resolve(fixtures.basic, ".."), "errors/"],
  ])("refuses to list a directory outside the root through %s", (_label, target, sibling) => {
    const { code, stdout } = run([target], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).not.toContain(sibling);
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

  it("reports frontmatter issues", () => {
    const { code, stdout } = run(["--check"], fixtures.errors);
    expect(code).toBe(1);
    expect(stdout).toContain("unterminated-frontmatter.md");
    expect(stdout).toContain("missing-frontmatter.md");
    expect(stdout).not.toContain("missing-summary.md");
  });
});

describe("--root propagation", () => {
  it("propagates the selected root into suggested commands", () => {
    // `run` passes `--root <fixture>`; the propagated substring ignores the runner prefix.
    const { code, stdout } = run([], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain(`--root ${fixtures.basic} --recursive`);
    expect(stdout).toContain(`--root ${fixtures.basic} --guide`);
  });
});

describe("--search", () => {
  it.each([
    ["database", ["backend/database.md"], ["code-style.md", "backend/api-guide.md"]],
    ["code-style", ["code-style.md"], ["getting-started.md"]],
    ["backend", ["backend/database.md", "backend/api-guide.md"], ["code-style.md"]],
  ])("matches %s against frontmatter, basename or directory", (query, found, absent) => {
    const { code, stdout } = run(["--search", query], fixtures.basic);
    expect(code).toBe(0);
    for (const rel of found) expect(stdout).toContain(dp(fixtures.basic, rel));
    for (const rel of absent) expect(stdout).not.toContain(dp(fixtures.basic, rel));
  });
});

describe("--search ranking", () => {
  it.each([
    ["basic", "guide api", "backend/api-guide.md", "backend/database.md"],
    ["search", "gateway", "gateway.md", "notes.md"],
    ["search", "gateway", "gateway.md", "spam.md"],
    ["search", "log", "log.md", "logging.md"],
    ["search", "shared", "tie-a.md", "tie-b.md"],
  ] as const)("ranks in %s for %j: %s before %s", (fixture, query, first, second) => {
    const { code, stdout } = run(["--search", query], fixtures[fixture]);
    expect(code).toBe(0);
    const firstIdx = stdout.indexOf(dp(fixtures[fixture], first));
    const secondIdx = stdout.indexOf(dp(fixtures[fixture], second));
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
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
});

describe("--search folding (search fixture)", () => {
  it.each([
    ["specification", "accent.md"],
    ["spécification", "plain.md"],
    ["workspaces", "workspace.md"],
    ["dependency", "plurals.md"],
    ["dependencies", "singulars.md"],
    ["cheval", "elevage.md"],
    ["index", "plurals.md"],
    ["indices", "singulars.md"],
    ["yeux", "ciel.md"],
  ])("finds %s in %s", (query, rel) => {
    expect(run(["--search", query], fixtures.search).stdout).toContain(dp(fixtures.search, rel));
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
  it.each([
    [
      "after a text prelude",
      "Some text\n\n# Heading After Prelude\n\nBody",
      "Heading After Prelude",
    ],
    ["past a backtick fence", "```bash\n# not a title\n```\n\n# Real Title", "Real Title"],
    ["past a 4-backtick fence", "````\n# not a title\n````\n\n# Real Title", "Real Title"],
    ["past a tilde fence", "~~~\n# not a title\n~~~\n\n# Real Title", "Real Title"],
    ["without a heading", "Just some text\nwithout any heading", undefined],
  ])("finds the title %s", (_label, content, title) => {
    expect(extractFallbackTitle(content)).toBe(title);
  });
});

describe("invocation-aware CLI prefixes", () => {
  // Runner selection itself is covered in invocation.test.ts. This checks the CLI wiring: the
  // verified script reaches help and guide literally (`$&` would re-insert the placeholder under
  // string replacement patterns), with its forwarding separator and the quoted root folded in.
  it("renders a verified npm script with the folded root in help and guide", () => {
    const cwd = mkdtempSync(join(tmpdir(), "docmap-script-"));
    try {
      const name = "docs$&";
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
      for (const mode of ["--help", "--guide"]) {
        const { stdout } = invokeWith({
          argv: ["node", entryPoint, mode, "--root", "docs' quoted\\path"],
          evidence,
          cwd,
        });
        expect(stdout).toContain(`npm run 'docs$&' -- --root 'docs'\\'' quoted\\path' --check`);
        expect(stdout).not.toContain("{{");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("injected command prefix", () => {
  it("folds --root into the enclosing CLI's prefix", () => {
    const commands = { base: "alignfirst docmap", withArgs: "alignfirst docmap" };
    const out = invoke(["node", "docmap", "--root", "my docs", "--help"], "/", commands).stdout;
    expect(out).toContain("alignfirst docmap --root 'my docs' --check");
  });
});
