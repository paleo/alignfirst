import { parseArgs } from "node:util";

import {
  ASSISTANT_HARNESS_VARIABLE,
  HARNESSES,
  type Harness,
  type Platform,
  platformOf,
  resolveAssistantHarness,
} from "../assistant-harness.js";
import { resolveEfforts } from "../code/efforts.js";
import { resolveModels } from "../code/models.js";
import { describeNativeStorage } from "../code/native-context.js";
import type { CommandForms } from "../command-form.js";
import {
  enabledCodingProfiles,
  type LoadedConfig,
  requireProjectsRoot,
  resolveCodeConfig,
} from "../config.js";
import { errorMessage } from "../errors.js";
import { readProjectReport } from "../project/layout.js";
import type { ProjectsCallerContext } from "../project/project-cli.js";
import { renderCodeGuide } from "./code-guide.js";
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
    if (args.help) {
      ctx.stdout.write(renderUsage(ctx.forms));
      return 0;
    }
    const { harness } = resolveAssistantHarness(ctx.env);
    ctx.stdout.write(`${renderTopic(args, harness, config, ctx)}\n`);
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
      profile: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new Error("Error: `aligndev guide` takes at most one topic.");
  const [topic] = positionals;
  if (values.profile !== undefined && topic !== "code") {
    throw new Error("Error: --profile is valid only with `aligndev guide code`.");
  }
  return {
    topic,
    channel: parseChannel(values.channel),
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
  ${forms.aligndev} guide [--channel <slack|discord|app>] [<topic>] [--profile <name>]
  ${forms.aligndev} guide --help

The assistant's harness selects the playbook: ${ASSISTANT_HARNESS_VARIABLE} (${HARNESSES.join(", ")})
when set, else the detected coding agent, else openclaw under OPENCLAW_SHELL=exec. A recognized
coding-agent harness also selects the harness-specific text of the guides.

Without a topic, prints the dispatcher; with --channel alone, the surface's playbook. When the
assistant's harness is openclaw, every playbook topic requires --channel, code defaults to
--channel app, and project rejects it. The working-session and channel-handling topics print
after the playbook.

Topics:
  code        The delegation guide for \`${forms.aligndev} code\`.
  project     The projects guide, openclaw only.

Playbook topics, by context:
  thread (openclaw, --channel slack|discord): ${PLAYBOOK_TOPICS.thread.join(", ")}
  app (openclaw, --channel app): ${PLAYBOOK_TOPICS.app.join(", ")}
  codingAgent: ${PLAYBOOK_TOPICS.codingAgent.join(", ")}
`;
}

function renderTopic(
  args: GuideArgs,
  harness: Harness | undefined,
  config: LoadedConfig,
  ctx: ProjectsCallerContext,
): string {
  const platform = platformOf(harness);
  assertChannelUse(args, platform);
  const { topic, channel } = args;
  if (topic === "project" && platform === "openclaw") {
    return renderGuideTemplate("project.md", { platform: "openclaw" }, ctx.forms);
  }
  const active: ActiveBlocks = {
    platform,
    surface: channel,
    harness: harness === "openclaw" ? undefined : harness,
  };
  if (topic === undefined) {
    const name = channel === undefined ? PLAYBOOK_DISPATCHER : PLAYBOOK;
    return renderPlaybookTemplate(name, active, config, ctx.forms);
  }
  if (topic === "code") return renderCodeTopic(withCodeSurface(active), config, ctx, args.profile);
  return renderPlaybookTopic(topic, active, config, ctx);
}

function assertChannelUse({ topic, channel }: GuideArgs, platform: Platform): void {
  if (platform === "codingAgent") {
    if (channel !== undefined) {
      throw new Error("Error: --channel is valid only when the assistant's harness is openclaw.");
    }
    return;
  }
  if (topic === "project") {
    if (channel !== undefined) {
      throw new Error("Error: --channel is not valid with `aligndev guide project`.");
    }
    return;
  }
  if (topic !== undefined && topic !== "code" && channel === undefined) {
    throw new Error(
      "Error: --channel is required with a playbook topic when the assistant's harness is openclaw.",
    );
  }
}

// Operators validate profiles through `guide code` outside any session; the app surface serves them.
function withCodeSurface(active: ActiveBlocks): ActiveBlocks {
  if (active.platform !== "openclaw" || active.surface !== undefined) return active;
  return { ...active, surface: "app" };
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
  return renderCodeGuide({
    active,
    forms: ctx.forms,
    harness: code.harness,
    models: resolveModels(code.harness, code.models, code.modelAliases),
    defaultModel: code.defaultModel,
    efforts: resolveEfforts(code.harness, code.efforts),
    defaultEffort: code.defaultEffort,
    profile: code.profile,
    nativeStorage: describeNativeStorage(code),
    profiles: enabledCodingProfiles(config),
  });
}

// An entry topic prints after the playbook.
function renderPlaybookTopic(
  topic: string,
  active: ActiveBlocks,
  config: LoadedConfig,
  ctx: ProjectsCallerContext,
): string {
  assertPlaybookTopic(topic, active);
  const text = renderPlaybookTemplate(topic, active, config, ctx.forms);
  if (!ENTRY_TOPICS.includes(topic)) return text;
  return `${renderPlaybookTemplate(PLAYBOOK, active, config, ctx.forms)}\n\n${text}`;
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
  if (active.platform === "codingAgent") return renderGuideTemplate(template, active, forms);
  return renderGuideTemplate(template, active, forms, {
    PROJECTS_ROOT: requireProjectsRoot(config).written,
  });
}
