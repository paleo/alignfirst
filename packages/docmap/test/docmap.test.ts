import { resolve } from "node:path";
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
};

function run(args: string[], fixtureDir: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = main({
    argv: ["node", "docmap", "--root", fixtureDir, ...args],
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
    cwd: process.cwd(),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("default listing (basic fixture)", () => {
  it("lists root files with titles and summaries", () => {
    const { code, stdout } = run([], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("docs/code-style.md");
    expect(stdout).toContain("Code Style");
    expect(stdout).toContain("Conventions and formatting rules for the codebase.");
    expect(stdout).toContain("docs/getting-started.md");
    expect(stdout).toContain("Getting Started");
  });

  it("shows Sub-directories section", () => {
    const { stdout } = run([], fixtures.basic);
    expect(stdout).toContain("## Sub-directories");
    expect(stdout).toContain("- backend/");
    expect(stdout).toContain("- frontend/");
  });

  it("shows both tips", () => {
    const { stdout } = run([], fixtures.basic);
    expect(stdout).toContain("npm run docmap -- --dir");
    expect(stdout).toContain("npm run docmap -- --read");
  });
});

describe("--dir (basic fixture)", () => {
  it("lists only backend files", () => {
    const { code, stdout } = run(["--dir", "backend"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("`backend/`");
    expect(stdout).toContain("docs/backend/api-guide.md");
    expect(stdout).toContain("docs/backend/database.md");
    expect(stdout).not.toContain("docs/getting-started.md");
  });

  it("lists multiple dirs", () => {
    const { code, stdout } = run(["--dir", "backend", "--dir", "frontend"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("docs/backend/api-guide.md");
    expect(stdout).toContain("docs/frontend/components.md");
  });
});

describe("--recursive (basic fixture)", () => {
  it("lists all files across all directories", () => {
    const { code, stdout } = run(["--recursive"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("# Documentation");
    expect(stdout).toContain("docs/code-style.md");
    expect(stdout).toContain("docs/getting-started.md");
    expect(stdout).toContain("## `backend/`");
    expect(stdout).toContain("docs/backend/api-guide.md");
    expect(stdout).toContain("docs/backend/database.md");
    expect(stdout).toContain("## `frontend/`");
    expect(stdout).toContain("docs/frontend/components.md");
  });

  it("recursive from a specific dir", () => {
    const { code, stdout } = run(["--dir", "backend", "--recursive"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("docs/backend/api-guide.md");
    expect(stdout).toContain("docs/backend/database.md");
    expect(stdout).not.toContain("docs/frontend/");
  });
});

describe("--read (basic fixture)", () => {
  it("reads a file and strips frontmatter", () => {
    const { code, stdout } = run(["--read", "docs/getting-started.md"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain('<document_file path="docs/getting-started.md">');
    expect(stdout).toContain("# Getting Started");
    expect(stdout).toContain("</document_file>");
    // Frontmatter should be stripped
    expect(stdout).not.toContain("summary:");
  });

  it("reads multiple files", () => {
    const { code, stdout } = run(
      ["--read", "docs/getting-started.md", "--read", "docs/code-style.md"],
      fixtures.basic,
    );
    expect(code).toBe(0);
    expect(stdout).toContain('<document_file path="docs/getting-started.md">');
    expect(stdout).toContain('<document_file path="docs/code-style.md">');
  });

  it("shows file not found", () => {
    const { code, stdout } = run(["--read", "docs/nonexistent.md"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("⚠ File not found");
  });

  it("fuzzy search finds files recursively", () => {
    const { code, stdout } = run(["--read", "database.md"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain('<document_file path="docs/backend/database.md">');
    expect(stdout).toContain("# Database Guide");
  });
});

describe("--read combined with other flags", () => {
  it("--read + --dir shows both listing and document", () => {
    const { code, stdout } = run(
      ["--read", "docs/getting-started.md", "--dir", "backend"],
      fixtures.basic,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("docs/backend/api-guide.md");
    expect(stdout).toContain('<document_file path="docs/getting-started.md">');
  });

  it("--read + --recursive shows both listing and document", () => {
    const { code, stdout } = run(["--read", "docs/code-style.md", "--recursive"], fixtures.basic);
    expect(code).toBe(0);
    expect(stdout).toContain("docs/backend/api-guide.md");
    expect(stdout).toContain("docs/frontend/components.md");
    expect(stdout).toContain('<document_file path="docs/code-style.md">');
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
    expect(stdout).toContain("docs/missing-summary.md");
    expect(stdout).toContain("Missing Summary Doc");
    expect(stdout).not.toContain("Missing 'summary'");
  });
});

describe("empty fixture", () => {
  it("shows no files and no tips", () => {
    const { code, stdout } = run([], fixtures.empty);
    expect(code).toBe(0);
    expect(stdout).not.toContain("npm run docmap -- --dir");
    expect(stdout).not.toContain("npm run docmap -- --read");
  });
});

describe("nested fixture with --recursive", () => {
  it("produces correct heading levels for deep nesting", () => {
    const { code, stdout } = run(["--recursive"], fixtures.nested);
    expect(code).toBe(0);
    expect(stdout).toContain("# Documentation");
    expect(stdout).toContain("docs/top-level.md");
    expect(stdout).toContain("## `level-one/`");
    expect(stdout).toContain("docs/level-one/doc-a.md");
    expect(stdout).toContain("### `level-two/`");
    expect(stdout).toContain("docs/level-one/level-two/deep-doc.md");
  });
});

describe("tip conditions", () => {
  it("only files (no subdirs) shows only read tip", () => {
    const { stdout } = run([], fixtures.errors);
    expect(stdout).not.toContain("npm run docmap -- --dir");
    expect(stdout).toContain("npm run docmap -- --read");
  });

  it("only subdirs (no files) shows only dir tip", () => {
    const { stdout } = run([], fixtures.subdirsOnly);
    expect(stdout).toContain("npm run docmap -- --dir");
    expect(stdout).not.toContain("npm run docmap -- --read");
  });

  it("--recursive does not show dir tip even when subdirs exist", () => {
    const { stdout } = run(["--recursive"], fixtures.basic);
    expect(stdout).not.toContain("--dir");
  });

  it("--recursive shows read tip when files exist", () => {
    const { stdout } = run(["--recursive"], fixtures.basic);
    expect(stdout).toContain("npm run docmap -- --read");
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
