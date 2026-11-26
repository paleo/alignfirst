import type { CodingAgent } from "../code/coding-agent.js";
import { resolveEfforts } from "../code/efforts.js";
import { resolveModels } from "../code/models.js";
import type { CommandForms } from "../command-form.js";
import type { CodingProfile, NamedProfile } from "../config.js";
import { escapeControlCharacters } from "../project/format.js";
import { type ActiveBlocks, renderGuideTemplate } from "./render-template.js";

export interface CodeGuideOptions {
  active: ActiveBlocks;
  forms: CommandForms;
  harness: CodingAgent;
  models: readonly string[] | undefined;
  defaultModel?: string;
  efforts: readonly string[];
  defaultEffort?: string;
  // The selected profile's name; null for built-in defaults.
  profile?: string | null;
  // The enabled coding-agent profiles of the settings.
  profiles?: NamedProfile<CodingProfile>[];
}

export function renderCodeGuide(options: CodeGuideOptions): string {
  const {
    active,
    forms,
    harness,
    models,
    defaultModel,
    efforts,
    defaultEffort,
    profile = null,
  } = options;
  return renderGuideTemplate("code.md", active, forms, {
    AGENT: harness,
    PROFILE: profile ?? "(built-in)",
    PROFILES: renderProfiles(options.profiles ?? [], profile),
    PERMISSIONS: permissions(harness),
    MODEL_POLICY:
      models === undefined
        ? openModelPolicy(harness)
        : `One of ${models.map((model) => `\`${model}\``).join(", ")}`,
    DEFAULT_MODEL:
      defaultModel === undefined ? "the coding agent's default" : `\`${defaultModel}\``,
    EFFORT_POLICY: `One of ${efforts.map((level) => `\`${level}\``).join(", ")}`,
    DEFAULT_EFFORT:
      defaultEffort === undefined ? "the coding agent's default" : `\`${defaultEffort}\``,
    ALIGNFIRST_SETUP: `The project must be prepared for AlignFirst. AlignDev uses \`${forms.alignfirst}\` for the AlignFirst CLI.`,
    ALIGNFIRST_USE: `\`${forms.aligndev} code\` and the agent use the same AlignFirst command: \`${forms.alignfirst} guide <protocol>\` in the project.`,
  });
}

function permissions(harness: CodingAgent): string {
  switch (harness) {
    case "claude":
      return "Normal runs use `--permission-mode auto`, plus `--add-dir <companion>` for a project with a companion directory. `profile.skipPermissions: true` in the aligndev settings selects `--dangerously-skip-permissions`";
    case "codex":
      return "Normal runs use `--sandbox workspace-write`, plus `--add-dir <companion>` for a project with a companion directory. `profile.skipPermissions: true` in the aligndev settings selects `--dangerously-bypass-approvals-and-sandbox`";
    case "pi":
      return "Pi uses ordinary OS permissions, including companion access. `profile.skipPermissions` has no effect. Saved project trust is honored; no forced approval is passed";
    case "agy":
      return "Normal runs use Antigravity's auto mode with its terminal sandbox, plus `--add-dir <companion>` for a project with a companion directory and `--add-dir <git common directory>` in a linked worktree. `profile.skipPermissions: true` in the aligndev settings selects `--dangerously-skip-permissions`";
  }
}

// The policy of a harness without a finite model list.
function openModelPolicy(harness: CodingAgent): string {
  return harness === "agy"
    ? "Any nonblank Antigravity model name, preferably a base name such as `gemini-3.8-flash` with `--effort`"
    : "Any nonblank pi-native selector, preferably `provider/model` (thinking suffixes supported; `--effort` overrides them)";
}

// Trusts the settings: no executable, login or environment value is consulted.
function renderProfiles(profiles: NamedProfile<CodingProfile>[], selected: string | null): string {
  if (profiles.length === 0) {
    return "No named profile is configured: the agent runs with the built-in defaults of its harness.";
  }
  const rows = profiles.map(({ name, profile }) =>
    [
      cell(name),
      profile.harness,
      name === selected ? "yes" : "no",
      profile.default === true ? "yes" : "no",
      renderModels(profile),
      profile.defaultModel === undefined ? "native default" : cell(profile.defaultModel),
      resolveEfforts(profile.harness, profile.efforts).map(cell).join(", "),
      profile.defaultEffort === undefined ? "native default" : cell(profile.defaultEffort),
    ].join(" | "),
  );
  return [
    "| Profile | Harness | Selected | Default | Models | Default model | Efforts | Default effort |",
    "|---------|---------|----------|---------|--------|---------------|---------|----------------|",
    ...rows.map((row) => `| ${row} |`),
    "",
    "Pass `--profile <name>` for another agent or account; omit it to keep the selected profile.",
  ].join("\n");
}

function renderModels(profile: CodingProfile): string {
  const models = resolveModels(profile.harness, profile.models, profile.modelAliases);
  if (models !== undefined) return models.map(cell).join(", ");
  const aliases = Object.keys(profile.modelAliases ?? {});
  if (aliases.length === 0) return "any native selector";
  return `any native selector; aliases ${aliases.map(cell).join(", ")}`;
}

function cell(value: string): string {
  return `\`${escapeControlCharacters(value).replaceAll("|", "\\|")}\``;
}
