import type { ResolvedProjectConfig } from "./project-config.js";

export interface Output {
  write(text: string): void;
}

export interface Streams {
  stdout: Output;
  stderr: Output;
}

export interface CommandContext extends Streams {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  form: string;
  version: string;
  projectConfig?: ResolvedProjectConfig;
}
