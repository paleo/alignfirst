import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ALIGNFIRST_BIN = fileURLToPath(
  new URL("../../alignfirst/bin/alignfirst.mjs", import.meta.url),
);

// The environment of a run through `npx`: the guides print the `npx -y` command forms.
export const NPX_ENV = {
  npm_config_user_agent: "npm/11.19.0 node/v26.0.0 linux x64",
  npm_command: "exec",
  npm_lifecycle_event: "npx",
};

export interface Sink {
  write(text: string): void;
  text(): string;
}

// Single-profile fixture builder: `code` is the profile body, emitted under code.profiles.test and
// named by code.fallbackProfile. A detected coding agent selects its built-ins over the fallback.
// Temporary home/HOME values keep native settings and the companion registry test-local.
export function writeConfig(
  home: string,
  config: { projectsRoot?: string; code?: object },
): string {
  const { code, ...settings } = config;
  return writeSettings(home, {
    ...settings,
    ...(code === undefined ? {} : { code: { fallbackProfile: "test", profiles: { test: code } } }),
  });
}

// Writes the actual settings schema, for multi-profile and structural-validation fixtures.
export function writeSettings(home: string, config: object): string {
  const path = join(home, ".alignfirst", "aligndev.settings.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, undefined, 2)}\n`);
  return path;
}

export function makeSink(): Sink {
  let buffer = "";
  return {
    write(text: string) {
      buffer += text;
    },
    text: () => buffer,
  };
}

export function writeRegistry(home: string, value: object): void {
  const path = join(home, ".alignfirst", "companions", "registry.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`);
}
