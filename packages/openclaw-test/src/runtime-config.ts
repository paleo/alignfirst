import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function writeRuntimeConfig(projectPath: string, config: unknown): string {
  const projectDir = realpathSync(projectPath);
  const root = configRoot(projectDir);
  const daemonId = dockerDaemonId();
  const dir = mkdtempSync(join(root, "openclaw-test-config-"));
  try {
    writeFileSync(
      join(dir, "owner.json"),
      JSON.stringify({ projectDir, daemonId, pid: process.pid }),
      { mode: 0o600 },
    );
    const path = join(dir, "openclaw.json");
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
    return path;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupRuntimeConfigs(projectPath: string): void {
  try {
    const projectDir = realpathSync(projectPath);
    const root = configRoot(projectDir);
    const daemonId = dockerDaemonId();
    const dirs = readdirSync(root)
      .filter((name) => name.startsWith("openclaw-test-config-"))
      .map((name) => join(root, name))
      .filter((dir) => isOwnedConfig(dir, projectDir, daemonId));
    if (dirs.length === 0) return;
    const sources = containerMountSources();
    if (sources === undefined) {
      console.warn("openclaw-test: cannot confirm container mounts; retaining runtime configs");
      return;
    }
    for (const dir of dirs) {
      if (!sources.some((source) => pathsOverlap(source, dir))) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch (error) {
    // Config collection must not replace a matrix or teardown result.
    console.warn(`openclaw-test: retaining runtime configs: ${String(error)}`);
  }
}

function configRoot(projectDir: string): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome !== undefined && xdgStateHome !== ""
      ? xdgStateHome
      : join(homedir(), ".local", "state");
  if (!isAbsolute(stateHome)) {
    throw new Error("openclaw-test: XDG_STATE_HOME must be absolute");
  }
  const key = createHash("sha256").update(projectDir).digest("hex");
  const appRoot = join(stateHome, "openclaw-test");
  const root = join(appRoot, key);
  const physicalRoot = physicalPath(root);
  const privatePaths = [
    projectDir,
    process.env.OPENCLAW_TEST_PACKAGE_DIR,
    process.env.OPENCLAW_TEST_ARTIFACTS_DIR,
    process.env.OPENCLAW_TEST_GATEWAY_LOGS_DIR,
  ];
  if (
    privatePaths.some(
      (path) => path !== undefined && pathsOverlap(physicalPath(path), physicalRoot),
    )
  ) {
    throw new Error("openclaw-test: state root must be outside the project, package and outputs");
  }
  mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  const state = lstatSync(stateHome);
  if (!state.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o022) !== 0) {
    throw new Error(`openclaw-test: unsafe state directory: ${stateHome}`);
  }
  ensurePrivateDirectory(appRoot);
  ensurePrivateDirectory(root);
  return realpathSync(root);
}

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`openclaw-test: unsafe private state directory: ${path}`);
  }
}

function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return join(physicalPath(dirname(resolve(path))), basename(path));
  }
}

function dockerDaemonId(): string {
  const result = spawnSync("docker", ["info", "--format", "{{.ID}}"], { encoding: "utf8" });
  const id = result.stdout?.trim();
  if (result.status !== 0 || id === undefined || id === "") {
    throw new Error("cannot identify Docker daemon for runtime config ownership");
  }
  return id;
}

interface ConfigOwner {
  projectDir: string;
  daemonId: string;
  pid: number;
}

function isOwnedConfig(dir: string, projectDir: string, daemonId: string): boolean {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    return false;
  }
  let owner: ConfigOwner;
  try {
    const ownerFile = join(dir, "owner.json");
    const ownerStat = lstatSync(ownerFile);
    if (
      !ownerStat.isFile() ||
      ownerStat.uid !== process.getuid?.() ||
      (ownerStat.mode & 0o777) !== 0o600
    ) {
      return false;
    }
    owner = JSON.parse(readFileSync(ownerFile, "utf8"));
  } catch {
    return false;
  }
  if (
    owner?.projectDir !== projectDir ||
    owner.daemonId !== daemonId ||
    !Number.isInteger(owner.pid) ||
    owner.pid < 1
  ) {
    return false;
  }
  if (owner.pid === process.pid) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

function containerMountSources(): string[] | undefined {
  // Include stopped containers: Docker can start them again with the same binds.
  const listed = spawnSync("docker", ["ps", "--all", "--quiet", "--no-trunc"], {
    encoding: "utf8",
  });
  if (listed.status !== 0) return;
  const ids = listed.stdout.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return [];
  const sources: string[] = [];
  for (const id of ids) {
    const result = spawnSync("docker", ["inspect", id], { encoding: "utf8" });
    if (result.status !== 0) return;
    let containers: unknown;
    try {
      containers = JSON.parse(result.stdout);
    } catch {
      return;
    }
    if (!Array.isArray(containers) || containers.length !== 1) return;
    const container = containers[0];
    if (!container || container.Id !== id || !Array.isArray(container.Mounts)) return;
    for (const mount of container.Mounts) {
      if (!mount || typeof mount.Type !== "string") return;
      if (mount.Type !== "bind") continue;
      if (typeof mount.Source !== "string" || !isAbsolute(mount.Source)) return;
      sources.push(physicalPath(mount.Source));
    }
  }
  return sources;
}

function pathsOverlap(first: string, second: string): boolean {
  return containsPath(first, second) || containsPath(second, first);
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
