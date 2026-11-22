import { renderCommand } from "@alignfirst/docmap/invocation";

import type { CommandContext } from "./context.js";
import {
  COMMAND_SKILLS,
  findInstalledSkill,
  type InstalledSkill,
  resolveSkillRoots,
  skillsCommand,
} from "./skills.js";

export interface InspectionLine {
  level: "ok" | "info" | "warn" | "error";
  text: string;
}

export function inspectGlobalSkills(ctx: CommandContext): InspectionLine[] {
  const roots = resolveSkillRoots(ctx);
  const update = renderCommand(skillsCommand(ctx), ["update", "--global", "--yes"]);
  const alignfirst = findInstalledSkill(roots, "alignfirst");
  const alignfirstLine: InspectionLine =
    alignfirst === undefined
      ? { level: "ok", text: "alignfirst none" }
      : describeInstalledSkill("alignfirst", alignfirst, update);
  const aligndevLine = describeAligndevSkill(findInstalledSkill(roots, "aligndev"));
  const commands = COMMAND_SKILLS.map((name) => ({
    name,
    installed: findInstalledSkill(roots, name),
  }));
  if (commands.every(({ installed }) => installed === undefined))
    return [alignfirstLine, aligndevLine, { level: "ok", text: "no command skill installed" }];
  return [
    alignfirstLine,
    aligndevLine,
    ...commands.map((command) => describeCommandSkill(command, update)),
  ];
}

function describeAligndevSkill(installed: InstalledSkill | undefined): InspectionLine {
  if (installed === undefined) return { level: "info", text: "aligndev none" };
  return { level: "info", text: `aligndev ${installed.version ?? "unknown"} (${installed.root})` };
}

interface CommandSkill {
  name: string;
  installed: InstalledSkill | undefined;
}

function describeCommandSkill({ name, installed }: CommandSkill, update: string): InspectionLine {
  if (installed === undefined) return { level: "warn", text: `${name} missing` };
  return describeInstalledSkill(name, installed, update);
}

function describeInstalledSkill(
  name: string,
  installed: InstalledSkill,
  update: string,
): InspectionLine {
  const version = installed.version ?? "unknown";
  const major = majorOf(installed.version);
  if (major === undefined || major < 4)
    return {
      level: "warn",
      text: `${name} ${version} predates v4; update: ${update}`,
    };
  return { level: "ok", text: `${name} ${version} (${installed.root})` };
}

function majorOf(version: string | undefined): number | undefined {
  if (version === undefined) return;
  const match = /^(\d+)\./.exec(version);
  return match === null ? undefined : Number(match[1]);
}
