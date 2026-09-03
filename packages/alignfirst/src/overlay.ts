import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "./cli-error.js";
import { gitOutputOrUndefined } from "./git.js";
import { readProjectConfig, type ProjectConfig } from "./project-config.js";

export interface Overlay {
  dir: string;
  config: ProjectConfig;
  matchedBy: "remote" | "paths";
}

export interface ProjectFile {
  path: string;
  source: "root" | "overlay";
}

export interface ResolvedProjectConfig {
  config: ProjectConfig;
  source: "root" | "overlay";
  overlay?: Overlay;
}

export function findOverlay(
  cwd: string,
  env: NodeJS.ProcessEnv,
  home: string,
): Overlay | undefined {
  const configuredDir = env.ALIGNFIRST_OVERLAYS;
  if (configuredDir === undefined || configuredDir === "") return;
  const overlaysDir = expandHome(configuredDir, home);
  const candidates = readOverlayCandidates(overlaysDir);
  const origin = gitOutputOrUndefined(cwd, "remote", "get-url", "origin");
  const normalizedOrigin =
    origin === undefined || origin === "" ? undefined : normalizeRemoteUrl(origin);
  const realCwd = realpathSync(cwd);
  const remoteMatches = candidates.filter(
    ({ config }) => normalizedOrigin !== undefined && config.project?.remote === normalizedOrigin,
  );
  if (remoteMatches.length > 0) return selectOverlay(remoteMatches, "remote");
  const pathMatches = candidates.filter(({ config }) => config.project?.paths?.includes(realCwd));
  if (pathMatches.length > 0) return selectOverlay(pathMatches, "paths");
  return;
}

interface OverlayCandidate {
  dir: string;
  config: ProjectConfig;
}

function expandHome(path: string, home: string): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function readOverlayCandidates(overlaysDir: string): OverlayCandidate[] {
  if (!existsSync(overlaysDir)) return [];
  return readdirSync(overlaysDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = join(overlaysDir, entry.name, "_project");
      const config = readProjectConfig(dir);
      return config === undefined ? [] : [{ dir, config }];
    });
}

function selectOverlay(candidates: OverlayCandidate[], matchedBy: Overlay["matchedBy"]): Overlay {
  if (candidates.length > 1)
    throw new CliError(
      `Multiple AlignFirst overlays match this project: ${candidates
        .map(({ dir }) => dir)
        .join(", ")}`,
    );
  const candidate = candidates[0];
  return { ...candidate, matchedBy };
}

export function normalizeRemoteUrl(url: string): string {
  const value = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const scpMatch = value.includes("://") ? null : /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(value);
  if (scpMatch) return `${scpMatch[1].toLowerCase()}/${scpMatch[2].replace(/^\/+/, "")}`;
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}`
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .replace(/^\/+/, "");
  } catch {
    return value;
  }
}

export function resolveProjectFile(
  cwd: string,
  overlay: Overlay | undefined,
  name: string,
): ProjectFile | undefined {
  const rootPath = join(cwd, name);
  if (existsSync(rootPath)) return { path: rootPath, source: "root" };
  if (overlay === undefined) return;
  const overlayPath = join(overlay.dir, name);
  if (existsSync(overlayPath)) return { path: overlayPath, source: "overlay" };
  return;
}

export function resolveProjectConfig(
  cwd: string,
  env: NodeJS.ProcessEnv,
  home: string,
): ResolvedProjectConfig | undefined {
  const overlay = findOverlay(cwd, env, home);
  const rootConfig = readProjectConfig(cwd);
  if (rootConfig !== undefined) return { config: rootConfig, source: "root", overlay };
  if (overlay !== undefined) return { config: overlay.config, source: "overlay", overlay };
  return;
}
