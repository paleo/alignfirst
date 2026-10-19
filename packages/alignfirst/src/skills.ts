import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandContext } from "./context.js";

export const COMMAND_SKILLS = [
  "alspec",
  "alplan",
  "al",
  "alcatchup",
  "alcatchupaad",
  "alcatchupspec",
  "almerge",
  "alreview",
  "aldescription",
] as const;

export const SKILL_ROOTS = [".agents/skills", ".claude/skills", ".codex/skills"] as const;

export interface InstalledSkill {
  root: string;
  version: string | undefined;
}

export function resolveSkillRoots(ctx: CommandContext): string[] {
  const roots = [
    ...SKILL_ROOTS.map((root) => join(ctx.home, root)),
    join(resolvePiAgentDir(ctx), "skills"),
  ];
  const seen = new Set<string>();
  return roots.filter((root) => {
    const canonical = existsSync(root) ? realpathSync(root) : resolve(root);
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

function resolvePiAgentDir({ home, cwd, env }: CommandContext): string {
  const value = env.PI_CODING_AGENT_DIR;
  if (value === undefined || value === "") return join(home, ".pi", "agent");
  if (value === "~") return home;
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")))
    return join(home, value.slice(2));
  if (/^file:\/\//.test(value)) return fileURLToPath(value);
  return resolve(cwd, value);
}

export function findInstalledSkill(
  roots: readonly string[],
  name: string,
): InstalledSkill | undefined {
  for (const root of roots) {
    const skillFile = join(root, name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    return { root, version: readSkillVersion(skillFile) };
  }
  return;
}

function readSkillVersion(path: string): string | undefined {
  const content = readFileSync(path, "utf-8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  if (frontmatter === undefined) return;
  const metadata = /^metadata:\s*\r?\n((?:^[ \t]+.*(?:\r?\n|$))*)/m.exec(frontmatter)?.[1];
  if (metadata === undefined) return;
  return /^\s+version:\s*"?([^"\r\n]+)"?\s*$/m.exec(metadata)?.[1]?.trim();
}
