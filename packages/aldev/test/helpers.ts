import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Sink {
  write(text: string): void;
  text(): string;
}

// Writes `<home>/.config/alignfirst/aldev.json` and returns its path. Every `main` call in the
// suites injects a temporary `home`, so no test reads the developer's real config.
export function writeConfig(home: string, config: object): string {
  const path = join(home, ".config", "alignfirst", "aldev.json");
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
