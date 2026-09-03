import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "./cli-error.js";
import type { CommandContext } from "./context.js";

export const STUB_SKILLS = [
  "alignfirst",
  "alspec",
  "alplan",
  "al",
  "alcatchup",
  "almerge",
  "alreview",
  "aldescription",
] as const;

export const SKILL_ROOTS = [".agents/skills", ".claude/skills", ".codex/skills"] as const;

export interface InstalledSkill {
  root: string;
  version: string | undefined;
}

export function findInstalledSkill(home: string, name: string): InstalledSkill | undefined {
  for (const relativeRoot of SKILL_ROOTS) {
    const root = join(home, relativeRoot);
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

export function installStubSkills(ctx: CommandContext, agents: string[]): void {
  const skillArgs = STUB_SKILLS.flatMap((skill) => ["--skill", skill]);
  const agentArgs = agents.flatMap((agent) => ["--agent", agent]);
  try {
    execFileSync(
      "npx",
      [
        "-y",
        "skills",
        "add",
        "https://github.com/paleo/alignfirst",
        "--global",
        "--yes",
        ...skillArgs,
        ...agentArgs,
      ],
      { cwd: ctx.cwd, env: ctx.env, stdio: "inherit" },
    );
  } catch {
    throw new CliError("Failed to install the AlignFirst skills globally.");
  }
}
