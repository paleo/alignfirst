import { type InvocationCommand, renderCommand } from "@alignfirst/docmap/invocation";
import { readFileSync } from "node:fs";

import { CliError } from "../cli-error.js";
import { renderCommandForm } from "../command-form.js";
import type { CommandContext } from "../context.js";
import { COMMAND_SKILLS, skillsCommand } from "../skills.js";

export const SETUP_TOPICS: readonly SetupTopic[] = [
  {
    name: "protocols",
    title: "Adopt the Protocols",
    description: "Adopt the AlignFirst protocols in a project.",
  },
  {
    name: "configuration",
    title: "Configuration File",
    description: "The `alignfirst.json` format and its sections.",
  },
  {
    name: "skills",
    title: "Install the Skills",
    description: "Install the global command skills.",
  },
  {
    name: "work-files",
    title: "Work-Files Repository",
    description: "Share `.plans` through a separate team repository.",
  },
  {
    name: "companion",
    title: "Companion Directory",
    description: "Keep AlignFirst files outside the repository.",
  },
  {
    name: "docmap",
    title: "Docmap",
    description: "Adopt Docmap for the project's documentation.",
  },
  {
    name: "docmap-bootstrap",
    title: "Bootstrap Documentation",
    description: "Create or extend `docs/` by exploring the codebase.",
  },
  {
    name: "docmap-migrate-docs",
    title: "Migrate Existing Documents",
    description: "Bring an existing docs folder to Docmap conventions.",
  },
  {
    name: "docmap-migrate-skills",
    title: "Migrate Skills to Documentation",
    description: "Move project knowledge from agent skills into `docs/`.",
  },
  {
    name: "workspace",
    title: "Workspace Recipe",
    description: "Author the workspace and dev-server recipe.",
  },
  { name: "paseo", title: "Paseo", description: "Wire AlignFirst workspaces into Paseo." },
  {
    name: "assistant-project",
    title: "Prepare a Project for an Assistant",
    description: "The contract a project meets before an assistant works on it.",
  },
  {
    name: "coding-agent-assistant",
    title: "A Coding Agent as the Assistant",
    description: "Run Claude Code, Codex, Pi or Antigravity as the AlignDev assistant.",
  },
  {
    name: "upgrade",
    title: "Upgrade AlignFirst",
    description: "Detect the installed layout and apply one-time migrations.",
  },
  {
    name: "upgrade-v1",
    title: "Upgrade from `_docs/` Instructions",
    description: "Migrate legacy `_docs/` instructions.",
  },
  {
    name: "upgrade-v2",
    title: "Upgrade from a Project Skill",
    description: "Migrate a standalone project skill.",
  },
  {
    name: "upgrade-v3",
    title: "Upgrade from Full-Content Skills",
    description: "Migrate full-content skills and `plans-share`.",
  },
  {
    name: "upgrade-workspaces",
    title: "Upgrade Multi-Stack Workspaces",
    description: "Clean break from workspace wrappers and `.alignfirst.json`.",
  },
];
export const PROJECT_PATH_PLACEHOLDER = "{{PROJECT_PATH}}";
const TOPICS_PLACEHOLDER = "{{TOPICS}}";
const SKILLS_PLACEHOLDER = "{{SKILLS}}";
const SKILLS_INSTALL_PLACEHOLDER = "{{SKILLS_INSTALL}}";
const SAMPLE_MANIFEST_PLACEHOLDER = "{{SAMPLE_MANIFEST}}";
const SKILLS_REPOSITORY = "https://github.com/paleo/alignfirst";
const SKILLS_PER_LINE = 4;

export interface SetupTopic {
  name: string;
  title: string;
  description: string;
}

export function renderTopic(ctx: CommandContext, name: string): string {
  const topic = SETUP_TOPICS.find((candidate) => candidate.name === name);
  if (topic === undefined)
    throw new CliError(`Unknown setup topic "${name}". Topics:\n${renderTopicList()}`);
  return renderSetupTemplate(ctx, `topics/${topic.name}.md`);
}

export function renderTopicList(): string {
  return SETUP_TOPICS.map(({ name, description }) => `- \`${name}\` — ${description}`).join("\n");
}

/** Renders every placeholder of the template contract except `{{PROJECT_PATH}}`. */
export function renderSetupTemplate(ctx: CommandContext, path: string): string {
  const template = renderCommandForm(readSetupTemplate(path), ctx.form);
  const skills = skillsCommand(ctx);
  return template
    .replaceAll(TOPICS_PLACEHOLDER, () => renderTopicList())
    .replaceAll(SKILLS_PLACEHOLDER, () => skills.base)
    .replaceAll(SKILLS_INSTALL_PLACEHOLDER, () => renderSkillsInstall(skills))
    .replaceAll(SAMPLE_MANIFEST_PLACEHOLDER, () => readSetupTemplate("examples/alignfirst.json"));
}

function readSetupTemplate(path: string): string {
  return readFileSync(new URL(`../../templates/setup/${path}`, import.meta.url), "utf-8").trimEnd();
}

function renderSkillsInstall(launcher: InvocationCommand): string {
  const install = renderCommand(launcher, ["add", SKILLS_REPOSITORY, "--global", "--yes"]);
  const skills = [...COMMAND_SKILLS, "aligndev"].map((name) => `--skill ${name}`);
  const lines = [install, "--agent <host>"];
  for (let i = 0; i < skills.length; i += SKILLS_PER_LINE)
    lines.push(skills.slice(i, i + SKILLS_PER_LINE).join(" "));
  return `${lines.join(" \\\n  ")} </dev/null`;
}
