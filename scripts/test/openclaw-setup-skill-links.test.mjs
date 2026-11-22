import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../skills/aligndev-openclaw-setup/", import.meta.url));

test("installed OpenClaw setup skill keeps its local links inside the skill directory", () => {
  const home = mkdtempSync(join(tmpdir(), "installed-openclaw-setup-skill-"));
  const skill = join(home, ".agents/skills/aligndev-openclaw-setup");
  try {
    cpSync(source, skill, { recursive: true });
    const entry = join(skill, "SKILL.md");
    for (const link of localLinks(entry)) assertInstalledDestination(skill, entry, link);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function localLinks(document) {
  const markdown = readFileSync(document, "utf8").replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gmu, "");
  return [...markdown.matchAll(/\]\(([^\s)]+)\)/gu)]
    .map((match) => match[1])
    .filter((link) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(link));
}

function assertInstalledDestination(skill, document, link) {
  const destination = resolve(dirname(document), decodeURIComponent(link.split("#")[0]));
  const description = `${relative(skill, document)} -> ${link}`;
  assert(
    existsSync(destination),
    `Missing installed-skill link target: ${description}; only the skill directory was copied`,
  );
  assert(
    destination.startsWith(`${skill}${sep}`),
    `Link escapes the installed skill: ${description}`,
  );
}
