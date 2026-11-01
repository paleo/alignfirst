import { isPlainObject } from "./json-shape.js";

export function normalizeAssistantInstructionsFile(value: unknown, label: string): unknown {
  if (!isPlainObject(value) || !Object.hasOwn(value, "developerInstructions")) return value;
  console.warn(
    `Warning: developerInstructions is deprecated in ${label}; use assistantInstructionsFile instead. ` +
      "assistantInstructionsFile takes precedence when both are set.",
  );
  const { developerInstructions, ...settings } = value;
  return {
    ...settings,
    ...(settings.assistantInstructionsFile === undefined && developerInstructions !== undefined
      ? { assistantInstructionsFile: developerInstructions }
      : {}),
  };
}
