import type { Overlay, ResolvedProjectConfig } from "./overlay.js";

export interface Output {
  write(text: string): void;
}

export interface CommandContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  stdout: Output;
  stderr: Output;
  form: string;
  version: string;
  projectConfig?: ResolvedProjectConfig;
  overlay?: Overlay;
}
