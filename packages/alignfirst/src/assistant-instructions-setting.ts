import { isPlainObject } from "./json-shape.js";

const DEPRECATED_CONFIG_PROPERTIES = ["assistantInstructionsFile", "developerInstructions"];

/** Both configuration properties are deprecated: the guide keeps its old name until the rename. */
export function normalizeConfiguredGuideName(value: unknown, label: string): unknown {
  if (!isPlainObject(value)) return value;
  for (const property of DEPRECATED_CONFIG_PROPERTIES.filter((name) => Object.hasOwn(value, name)))
    console.warn(
      `Warning: ${property} is deprecated in ${label}. ` +
        "Rename the assistant guide to ASSISTANTS.md and remove the property.",
    );
  return renameDeveloperInstructions(value);
}

/** `developerInstructions` is the old key of the registry's `assistantInstructionsFile` item. */
export function normalizeAssistantInstructionsItem(value: unknown, label: string): unknown {
  if (!isPlainObject(value) || !Object.hasOwn(value, "developerInstructions")) return value;
  console.warn(
    `Warning: developerInstructions is deprecated in ${label}; use assistantInstructionsFile instead. ` +
      "assistantInstructionsFile takes precedence when both are set.",
  );
  return renameDeveloperInstructions(value);
}

function renameDeveloperInstructions(value: Record<string, unknown>): Record<string, unknown> {
  const { developerInstructions, ...settings } = value;
  return {
    ...settings,
    ...(settings.assistantInstructionsFile === undefined && developerInstructions !== undefined
      ? { assistantInstructionsFile: developerInstructions }
      : {}),
  };
}
