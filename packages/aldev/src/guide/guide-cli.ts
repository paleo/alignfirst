import { parseArgs } from "node:util";

import { resolveModels } from "../code/models.js";
import {
  type AldevConfig,
  PLATFORMS,
  type Platform,
  requireCodeConfig,
  requirePlatform,
  requireProjectsRoot,
} from "../config.js";
import { errorMessage } from "../errors.js";
import { type ProjectsCallerContext, renderProjectsGuideForRoot } from "../project/project-cli.js";
import { readTemplate } from "../templates.js";
import { renderCodeGuide } from "./code-guide.js";
import { PLAYBOOK_DISPATCHER, PLAYBOOK_TOPICS } from "./topics.js";

interface GuideArgs {
  topic?: string;
  root?: string;
  help: boolean;
}

export function runGuide(
  tokens: string[],
  config: AldevConfig,
  ctx: ProjectsCallerContext,
): number {
  try {
    const args = parseGuideArgs(tokens);
    ctx.stdout.write(args.help ? renderUsage() : `${renderTopic(args, config, ctx)}\n`);
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
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new Error("Error: `aldev guide` takes at most one topic.");
  const [topic] = positionals;
  if (values.root !== undefined && topic !== "project") {
    throw new Error("Error: --root is valid only with `aldev guide project`.");
  }
  return { topic, root: values.root, help: values.help };
}

function renderUsage(): string {
  const playbookTopics = PLATFORMS.map(
    (platform) => `  ${platform}: ${PLAYBOOK_TOPICS[platform].join(", ")}`,
  );
  return `Usage:
  aldev guide [<topic>] [--root <path>]
  aldev guide --help

Without a topic, prints the playbook of the platform set in the aldev config.

Topics:
  code        The delegation guide for \`aldev code\`.
  project     The projects guide. --root overrides projectsRoot in the aldev config.

Playbook topics, by platform:
${playbookTopics.join("\n")}
`;
}

function renderTopic(args: GuideArgs, config: AldevConfig, ctx: ProjectsCallerContext): string {
  if (args.topic === "code") return renderCodeTopic(config);
  if (args.topic === "project") {
    return renderProjectsGuideForRoot({ ...ctx, projectsRoot: config.projectsRoot }, args.root);
  }
  return renderPlaybookTopic(args.topic, config);
}

function renderCodeTopic(config: AldevConfig): string {
  const code = requireCodeConfig(config);
  const models = resolveModels(code.agent, code.models);
  return renderCodeGuide(config.platform ?? "generic", code.agent, models);
}

// The topic is checked before the platform, so a topic unknown under every platform is reported as
// unknown even without `platform`.
function renderPlaybookTopic(topic: string | undefined, config: AldevConfig): string {
  if (topic !== undefined) assertPlaybookTopic(topic, config.platform);
  const platform = requirePlatform(config);
  const projectsRoot = requireProjectsRoot(config);
  return readTemplate(`guide/${platform}/${topic ?? PLAYBOOK_DISPATCHER}.md`)
    .replaceAll("{{PROJECTS_ROOT}}", projectsRoot.written)
    .trimEnd();
}

function assertPlaybookTopic(topic: string, platform: Platform | undefined): void {
  const topics =
    platform === undefined
      ? [...new Set(PLATFORMS.flatMap((candidate) => PLAYBOOK_TOPICS[candidate]))]
      : PLAYBOOK_TOPICS[platform];
  if (topics.includes(topic)) return;
  throw new Error(
    `Error: unknown guide topic "${topic}". Topics: ${["code", "project", ...topics].join(", ")}.`,
  );
}
