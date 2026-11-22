import { describe, expect, it } from "vitest";

import { diagnoseInstructions, insertSection } from "../src/setup/instructions.js";

const CANONICAL = `## Start every session with the project context

Run \`npx -y alignfirst context\` from the repository root once, as your first command in the session, whatever the task. It prints the project conventions, the documentation map, and the AlignFirst protocols.
`;
const PARAGRAPH = CANONICAL.split("\n\n")[1].trim();

describe("diagnoseInstructions", () => {
  it.each([
    [
      "absent without any mention",
      { "AGENTS.md": "# Project\n\n## Build\n\nnpm run build\n" },
      "absent",
    ],
    ["current for the canonical section", { "AGENTS.md": `# Project\n\n${CANONICAL}` }, "current"],
    [
      "current with another launcher and extra whitespace",
      {
        "AGENTS.md": `## Start every session with the project context\n\n${PARAGRAPH.replace("npx -y alignfirst", "pnpm exec alignfirst").replace(" once,", "\n  once,")}\n\nProject-specific rule.\n`,
      },
      "current",
    ],
    [
      "differs for an older wording",
      {
        "AGENTS.md":
          "## Start every session with the project context\n\nRun `npx -y alignfirst context` first.\n",
      },
      "differs",
    ],
    [
      "differs, and still detected, under a custom title",
      { "AGENTS.md": `## Bootstrap\n\n${PARAGRAPH}\n` },
      "differs",
    ],
    [
      "ambiguous for two sections",
      { "AGENTS.md": CANONICAL, "CLAUDE.md": "## Other\n\nRun `alignfirst context`.\n" },
      "ambiguous",
    ],
    [
      "ambiguous for a mention outside a level-2 section",
      { "AGENTS.md": `# Project\n\nRun \`alignfirst context\` first.\n\n${CANONICAL}` },
      "ambiguous",
    ],
    [
      "absent for a mention inside a code fence",
      {
        "AGENTS.md":
          "## Example\n\n```markdown\nRun `alignfirst context`.\n```\n\n~~~\nalignfirst context\n~~~\n",
      },
      "absent",
    ],
  ])("is %s", (_case, files, status) => {
    const diagnosis = diagnoseInstructions(
      Object.entries(files).map(([path, content]) => ({ path, content })),
      CANONICAL,
    );
    expect(diagnosis.status).toBe(status);
  });
});

describe("insertSection", () => {
  it.each([
    [
      "before the first heading of level 2 or deeper",
      "# Project\n\nIntro.\n\n```\n## not a heading\n```\n\n### Build\n\nnpm run build\n",
      "# Project\n\nIntro.\n\n```\n## not a heading\n```\n\nSECTION\nLINE\n\n### Build\n\nnpm run build\n",
    ],
    [
      "at the end without such a heading",
      "# Project\n\nIntro.\n",
      "# Project\n\nIntro.\n\nSECTION\nLINE\n",
    ],
    ["alone in an empty file", "", "SECTION\nLINE\n"],
    [
      "with the file's CRLF line endings",
      "# Project\r\n\r\nIntro.\r\n\r\n## Build\r\n",
      "# Project\r\n\r\nIntro.\r\n\r\nSECTION\r\nLINE\r\n\r\n## Build\r\n",
    ],
  ])("inserts %s", (_case, content, expected) => {
    expect(insertSection(content, "SECTION\nLINE\n")).toBe(expected);
  });
});
