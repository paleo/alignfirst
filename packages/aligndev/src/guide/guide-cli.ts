import { parseArgs } from "node:util";

import { resolveModels } from "../code/models.js";
import type { CommandForms } from "../command-form.js";
import {
  type LoadedConfig,
  PLATFORMS,
  type Platform,
  requireProjectsRoot,
  resolveCodeConfig,
} from "../config.js";
import { errorMessage } from "../errors.js";
import { readProjectReport } from "../project/layout.js";
import { type ProjectsCallerContext, renderProjectsGuideForRoot } from "../project/project-cli.js";
import { renderCodeGuide } from "./code-guide.js";
import { resolveGuideFile } from "./guide-file.js";
import { renderGuideTemplate } from "./render-template.js";
import { PLAYBOOK_DISPATCHER, PLAYBOOK_TOPICS } from "./topics.js";

interface GuideArgs {
  topic?: string;
  root?: string;
  profile?: string;
  help: boolean;
}

export function runGuide(
  tokens: string[],
  config: LoadedConfig,
  ctx: ProjectsCallerContext,
): number {
  try {
    const args = parseGuideArgs(tokens);
    ctx.stdout.write(args.help ? renderUsage(ctx.forms) : `${renderTopic(args, config, ctx)}\n`);
    return 0;
  } catch (error) {
    ctx.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

function parseGuideArgs(tokens: string[]): GuideArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      root: { type: "string" },
      profile: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new Error("Error: `aligndev guide` takes at most one topic.");
  const [topic] = positionals;
  if (values.root !== undefined && topic !== "project") {
    throw new Error("Error: --root is valid only with `aligndev guide project`.");
  }
  if (values.profile !== undefined && topic !== "code") {
    throw new Error("Error: --profile is valid only with `aligndev guide code`.");
  }
  return { topic, root: values.root, profile: values.profile, help: values.help };
}

function renderUsage(forms: CommandForms): string {
  const playbookTopics = PLATFORMS.map(
    (platform) => `  ${platform}: ${PLAYBOOK_TOPICS[platform].join(", ")}`,
  );
  return `Usage:
  ${forms.aligndev} guide [<topic>] [--root <path>] [--profile <name>]
  ${forms.aligndev} guide --help

Without a topic, prints the playbook of the platform set in the aligndev settings.

Topics:
  code        The delegation guide for \`${forms.aligndev} code\`.
  project     The projects guide, openclaw only. --root overrides projectsRoot in the aligndev settings.

Playbook topics, by platform:
${playbookTopics.join("\n")}
`;
}

function renderTopic(args: GuideArgs, config: LoadedConfig, ctx: ProjectsCallerContext): string {
  if (args.topic === "code") return renderCodeTopic(config, ctx, args.profile);
  if (args.topic === "project" && config.platform === "openclaw") {
    return renderProjectsGuideForRoot({ ...ctx, projectsRoot: config.projectsRoot }, args.root);
  }
  return renderPlaybookTopic(args.topic, config, ctx);
}

function renderCodeTopic(
  config: LoadedConfig,
  ctx: ProjectsCallerContext,
  profile?: string,
): string {
  const report = readProjectReport(ctx.alignfirstCommand, ctx.cwd, ctx.env);
  if ("error" in report) throw new Error(report.error);
  const code = resolveCodeConfig(config, ctx.env, { project: report.aligndev, explicit: profile });
  const models = resolveModels(code.agent, code.models, code.modelAliases);
  return renderCodeGuide(
    config.platform,
    code.agent,
    models,
    code.defaultModel,
    ctx.forms,
    code.profile,
    code.configDir,
  );
}

function renderPlaybookTopic(
  topic: string | undefined,
  config: LoadedConfig,
  ctx: ProjectsCallerContext,
): string {
  if (topic !== undefined) assertPlaybookTopic(topic, config.platform);
  const name = `playbook/${topic ?? PLAYBOOK_DISPATCHER}.md`;
  if (config.platform === "codingAgent") {
    const active = { platform: config.platform, guideFile: resolveGuideFile(ctx) };
    return renderGuideTemplate(name, active, ctx.forms);
  }
  return renderGuideTemplate(name, { platform: config.platform }, ctx.forms, {
    PROJECTS_ROOT: requireProjectsRoot(config).written,
  });
}

function assertPlaybookTopic(topic: string, platform: Platform): void {
  const topics = PLAYBOOK_TOPICS[platform];
  if (topics.includes(topic)) return;
  const specialTopics = platform === "openclaw" ? ["code", "project"] : ["code"];
  throw new Error(
    `Error: unknown guide topic "${topic}". Topics: ${[...specialTopics, ...topics].join(", ")}.`,
  );
}
