import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../skills/alignfirst-setup-guide/", import.meta.url));

test("installed setup skill keeps reference traversal self-contained", () => {
  const home = mkdtempSync(join(tmpdir(), "installed-setup-skill-"));
  const skill = join(home, ".agents/skills/alignfirst-setup-guide");
  try {
    cpSync(source, skill, { recursive: true });
    const entry = join(skill, "SKILL.md");
    const pending = [entry];
    const visited = new Set();
    while (pending.length > 0) {
      const document = pending.pop();
      if (visited.has(document)) continue;
      visited.add(document);
      for (const link of localLinks(document)) {
        const destination = installedDestination(skill, document, link);
        if (
          destination === entry ||
          (destination.startsWith(`${join(skill, "references")}${sep}`) &&
            destination.endsWith(".md"))
        )
          pending.push(destination);
      }
    }
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

function installedDestination(skill, document, link) {
  const destination = resolve(dirname(document), decodeURIComponent(link.split("#")[0]));
  const description = `${relative(skill, document)} -> ${link}`;
  assert(
    existsSync(destination),
    `Missing installed-skill reference: ${description}; only the skill directory was copied`,
  );
  assert(
    destination.startsWith(`${skill}${sep}`),
    `Reference escapes the installed skill: ${description}`,
  );
  return destination;
}
