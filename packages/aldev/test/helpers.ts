import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ALIGNFIRST_BIN = fileURLToPath(
  new URL("../../alignfirst/bin/alignfirst.mjs", import.meta.url),
);

export interface Sink {
  write(text: string): void;
  text(): string;
}

// Writes `<home>/.config/alignfirst/aldev.config.json` and returns its path. Every `main` call in
// the suites injects a temporary `home`, and sets `HOME` to it for alignfirst, so no test reads the
// developer's real config.
export function writeConfig(home: string, config: object): string {
  const path = join(home, ".config", "alignfirst", "aldev.config.json");
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

export function writeCompanions(home: string, value: object): void {
  const path = join(home, ".config", "alignfirst", "companions.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`);
}

export interface CompanionProject {
  home: string;
  project: string;
  companion: string;
}

// A git repository `<home>/app` whose companion is `<home>/companions/app` (not created). Paths
// are real.
export function makeCompanionProject(
  home: string,
  flags: Record<string, boolean | "auto">,
): CompanionProject {
  const project = join(home, "app");
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "--quiet", project]);
  writeCompanions(home, { root: "~/companions", paths: { "~/app": flags } });
  const realHome = realpathSync(home);
  return { home, project: realpathSync(project), companion: join(realHome, "companions", "app") };
}
