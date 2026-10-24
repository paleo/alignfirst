import { parseArgs } from "node:util";

import { resolveModels } from "../code/models.js";
import { describeNativeStorage } from "../code/native-context.js";
import type { CommandForms } from "../command-form.js";
import { type LoadedConfig, requireProjectsRoot, resolveCodeConfig } from "../config.js";
import { errorMessage } from "../errors.js";
import { readProjectReport } from "../project/layout.js";
import { type ProjectsCallerContext, renderProjectsGuideForRoot } from "../project/project-cli.js";
import { renderCodeGuide } from "./code-guide.js";
import { resolveGuideFile } from "./guide-file.js";
import {
  type ActiveBlocks,
  isSurface,
  renderGuideTemplate,
  SURFACES,
  type Surface,
} from "./render-template.js";
import {
  ENTRY_TOPICS,
  guideContextOf,
  PLAYBOOK,
  PLAYBOOK_DISPATCHER,
  PLAYBOOK_TOPICS,
  surfacesServing,
} from "./topics.js";

interface GuideArgs {
  topic?: string;
  channel?: Surface;
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
      channel: { type: "string" },
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
  return {
    topic,
    channel: parseChannel(values.channel),
    root: values.root,
    profile: values.profile,
    help: values.help,
  };
}

function parseChannel(value: string | undefined): Surface | undefined {
  if (value === undefined || isSurface(value)) return value;
  throw new Error(`Error: unknown --channel value "${value}". Surfaces: ${SURFACES.join(", ")}.`);
}

function renderUsage(forms: CommandForms): string {
  return `Usage:
  ${forms.aligndev} guide [--channel <slack|discord|app>] [<topic>] [--root <path>] [--profile <name>]
  ${forms.aligndev} guide --help

Without a topic, prints the dispatcher; with --channel alone, the surface's playbook. On the openclaw
platform, every topic but project requires --channel. The working-session and channel-handling
topics print after the playbook.

Topics:
  code        The delegation guide for \`${forms.aligndev} code\`.
  project     The projects guide, openclaw only. --root overrides projectsRoot in the aligndev settings.

Playbook topics, by context:
  thread (openclaw, --channel slack|discord): ${PLAYBOOK_TOPICS.thread.join(", ")}
  app (openclaw, --channel app): ${PLAYBOOK_TOPICS.app.join(", ")}
  codingAgent: ${PLAYBOOK_TOPICS.codingAgent.join(", ")}
`;
}

function renderTopic(args: GuideArgs, config: LoadedConfig, ctx: ProjectsCallerContext): string {
  assertChannelUse(args, config);
  const { topic, channel } = args;
  if (topic === "project" && config.platform === "openclaw") {
    return renderProjectsGuideForRoot({ ...ctx, projectsRoot: config.projectsRoot }, args.root);
  }
  const active: ActiveBlocks = { platform: config.platform, surface: channel };
  if (topic === undefined) {
    const name = channel === undefined ? PLAYBOOK_DISPATCHER : PLAYBOOK;
    return renderPlaybookTemplate(name, active, config, ctx.forms);
  }
  if (topic === "code") return renderCodeTopic(active, config, ctx, args.profile);
  return renderPlaybookTopic(topic, active, config, ctx);
}

function assertChannelUse({ topic, channel }: GuideArgs, config: LoadedConfig): void {
  if (config.platform === "codingAgent") {
    if (channel !== undefined) {
      throw new Error("Error: --channel is valid only on the openclaw platform.");
    }
    return;
  }
  if (topic === "project") {
    if (channel !== undefined) {
      throw new Error("Error: --channel is not valid with `aligndev guide project`.");
    }
    return;
  }
  if (topic !== undefined && channel === undefined) {
    throw new Error("Error: --channel is required with a topic on the openclaw platform.");
  }
}

function renderCodeTopic(
  active: ActiveBlocks,
  config: LoadedConfig,
  ctx: ProjectsCallerContext,
  profile?: string,
): string {
  const report = readProjectReport(ctx.alignfirstCommand, ctx.cwd, ctx.env);
  if ("error" in report) throw new Error(report.error);
  const code = resolveCodeConfig(config, ctx.env, { project: report.aligndev, explicit: profile });
  const models = resolveModels(code.agent, code.models, code.modelAliases);
  return renderCodeGuide(
    active,
    code.agent,
    models,
    code.defaultModel,
    ctx.forms,
    code.profile,
    describeNativeStorage(code),
  );
}

// An entry topic prints after the playbook. Under codingAgent, the playbook topics read the
// project's guide file; no other guide has a condition block.
function renderPlaybookTopic(
  topic: string,
  active: ActiveBlocks,
  config: LoadedConfig,
  ctx: ProjectsCallerContext,
): string {
  assertPlaybookTopic(topic, active);
  const topicActive: ActiveBlocks =
    active.platform === "codingAgent" ? { ...active, guideFile: resolveGuideFile(ctx) } : active;
  const text = renderPlaybookTemplate(topic, topicActive, config, ctx.forms);
  if (!ENTRY_TOPICS.includes(topic)) return text;
  return `${renderPlaybookTemplate(PLAYBOOK, topicActive, config, ctx.forms)}\n\n${text}`;
}

function assertPlaybookTopic(topic: string, active: ActiveBlocks): void {
  const topics = PLAYBOOK_TOPICS[guideContextOf(active)];
  if (topics.includes(topic)) return;
  const surfaces = surfacesServing(topic);
  if (active.surface !== undefined && surfaces.length > 0) {
    throw new Error(
      `Error: guide topic "${topic}" is not served on the ${active.surface} surface. Surfaces: ${surfaces.join(", ")}.`,
    );
  }
  const specialTopics = active.platform === "openclaw" ? ["code", "project"] : ["code"];
  throw new Error(
    `Error: unknown guide topic "${topic}". Topics: ${[...specialTopics, ...topics].join(", ")}.`,
  );
}

function renderPlaybookTemplate(
  name: string,
  active: ActiveBlocks,
  config: LoadedConfig,
  forms: CommandForms,
): string {
  const template = `playbook/${name}.md`;
  if (config.platform === "codingAgent") return renderGuideTemplate(template, active, forms);
  return renderGuideTemplate(template, active, forms, {
    PROJECTS_ROOT: requireProjectsRoot(config).written,
  });
}
