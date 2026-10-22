import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ALIGNFIRST_BIN = fileURLToPath(
  new URL("../../alignfirst/bin/alignfirst.mjs", import.meta.url),
);

export interface Sink {
  write(text: string): void;
  text(): string;
}

// Single-profile fixture builder: `code` is the profile body, emitted under code.profiles.test.
// Temporary home/HOME values keep native settings and the companion registry test-local.
export function writeConfig(
  home: string,
  config: { platform?: string; projectsRoot?: string; code?: object },
): string {
  const { code, ...settings } = config;
  return writeSettings(home, {
    ...settings,
    ...(code === undefined ? {} : { code: { profile: "test", profiles: { test: code } } }),
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

// Keep Git available when a fixture isolates PATH to exclude coding-agent executables.
export function installGit(directory: string): void {
  const git = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  symlinkSync(git, join(directory, "git"));
}

export function writeRegistry(home: string, value: object): void {
  const path = join(home, ".alignfirst", "companions", "registry.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`);
}

export interface CompanionProject {
  home: string;
  project: string;
  companion: string;
}

// A git repository `<home>/app` whose companion is `<home>/.alignfirst/companions/app` (not created). Paths
// are real.
export function makeCompanionProject(
  home: string,
  items: Record<string, "companion" | "project" | "auto">,
): CompanionProject {
  const project = join(home, "app");
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "--quiet", project]);
  writeRegistry(home, { projects: { "~/app": { dir: "app", items } } });
  const realHome = realpathSync(home);
  return {
    home,
    project: realpathSync(project),
    companion: join(realHome, ".alignfirst", "companions", "app"),
  };
}
