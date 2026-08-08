// Default model names accepted by --model. Bare tier names, resolved by the coding-agent CLI to
// its latest version. Extend when alcode supports another coding agent (e.g. Codex model names).
export const DEFAULT_MODELS = ["fable", "opus", "sonnet", "haiku"] as const;

// ALIGNFIRST_CODE_MODELS (comma-list) replaces the default list, for hosts whose plan lacks some
// tiers. Help and guide texts derive from the resolved list, so callers only see what the host has.
export function resolveModels(env: NodeJS.ProcessEnv): readonly string[] {
  const override = (env.ALIGNFIRST_CODE_MODELS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return override.length > 0 ? override : DEFAULT_MODELS;
}
