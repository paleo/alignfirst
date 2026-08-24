import {
  closeSync,
  lstatSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { availablePortRanges, type AlprojectConfig } from "./config.js";
import { AlprojectError, errorMessage, isNodeError } from "./errors.js";
import { resolveProjectPath } from "./paths.js";
import {
  allocateProjectPorts,
  allocationEnd,
  claimProjectPorts,
  projectPortCount,
  type PortRequest,
} from "./ports.js";
import { type PortAllocation, readRegistry, type Registry, registryPath } from "./registry.js";
import { type RegistryLockOptions, withRegistryLock } from "./registry-lock.js";

const atomicWriteOperations: AtomicWriteOperations = {
  close: closeSync,
  fsync: fsyncSync,
  open: openSync,
  rename: renameSync,
  unlink: unlinkSync,
  write: writeFileSync,
};

export interface RegistrationOptions {
  basePort?: number;
  maxWorkspaces?: number;
  portsPerWorkspace?: number;
}

export interface RegistrationResult {
  path: string;
  ports?: RegistrationPorts;
}

export interface RegistrationPorts extends PortRequest {
  basePort: number;
  endPort: number;
}

export interface MutationOptions {
  atomicWriteOperations?: Partial<AtomicWriteOperations>;
  lock?: RegistryLockOptions;
}

export interface AtomicWriteOperations {
  close: typeof closeSync;
  fsync: typeof fsyncSync;
  open: typeof openSync;
  rename: typeof renameSync;
  unlink: typeof unlinkSync;
  write: typeof writeFileSync;
}

export async function registerProject(
  config: AlprojectConfig,
  inputPath: string,
  options: RegistrationOptions = {},
  mutationOptions: MutationOptions = {},
): Promise<RegistrationResult> {
  const path = registrationPath(config, inputPath);
  const request = portRequest(options);

  return mutateRegistry(config, mutationOptions, (registry) => {
    if (registry.projects.some((project) => project.path === path)) {
      throw new AlprojectError("registry", `Project is already registered: ${path}`);
    }
    const ports = allocateRegistrationPorts(config, registry, path, request, options.basePort);
    registry.projects.push(ports === undefined ? { path } : { path, ports });
    return {
      path,
      ...(ports === undefined ? {} : { ports: { ...ports, endPort: allocationEnd(ports) } }),
    };
  });
}

export async function unregisterProject(
  config: AlprojectConfig,
  inputPath: string,
  mutationOptions: MutationOptions = {},
): Promise<string> {
  const path = mutationPath(config, inputPath);
  return mutateRegistry(config, mutationOptions, (registry) => {
    const index = registry.projects.findIndex((project) => project.path === path);
    if (index < 0) throw new AlprojectError("registry", `Project is not registered: ${path}`);
    registry.projects.splice(index, 1);
    return path;
  });
}

function registrationPath(config: AlprojectConfig, inputPath: string): string {
  const path = mutationPath(config, inputPath);
  assertMainWorktree(path);
  if (!config.projectParents.some((parent) => parent.path === dirname(path))) {
    throw new AlprojectError(
      "filesystem",
      `Project must be a direct child of an allowed project parent: ${path}`,
    );
  }
  return path;
}

function mutationPath(config: Pick<AlprojectConfig, "root">, inputPath: string): string {
  return resolveProjectPath(inputPath, config.root.path);
}

function assertMainWorktree(path: string): void {
  try {
    if (!statSync(path).isDirectory()) throw new Error("path is not a directory");
    if (!lstatSync(join(path, ".git")).isDirectory()) {
      throw new Error(".git is not a directory");
    }
  } catch (error) {
    throw new AlprojectError(
      "filesystem",
      `Project must be an existing Git main worktree: ${path} (${errorMessage(error)})`,
      { cause: error },
    );
  }
}

function portRequest(options: RegistrationOptions): PortRequest | undefined {
  const hasPortsPerWorkspace = options.portsPerWorkspace !== undefined;
  const hasMaxWorkspaces = options.maxWorkspaces !== undefined;
  if (hasPortsPerWorkspace !== hasMaxWorkspaces) {
    throw new AlprojectError(
      "registry",
      "portsPerWorkspace and maxWorkspaces must be provided together",
    );
  }
  if (
    !hasPortsPerWorkspace ||
    options.portsPerWorkspace === undefined ||
    options.maxWorkspaces === undefined
  ) {
    if (options.basePort !== undefined) {
      throw new AlprojectError("registry", "basePort requires portsPerWorkspace and maxWorkspaces");
    }
    return;
  }
  const request = {
    maxWorkspaces: options.maxWorkspaces,
    portsPerWorkspace: options.portsPerWorkspace,
  };
  projectPortCount(request);
  if (options.basePort !== undefined) {
    allocationEnd({ basePort: options.basePort, ...request });
  }
  return request;
}

function allocateRegistrationPorts(
  config: AlprojectConfig,
  registry: Registry,
  path: string,
  request: PortRequest | undefined,
  basePort: number | undefined,
): PortAllocation | undefined {
  if (request === undefined) return;
  const ranges = availablePortRanges(config, path);
  const allocation =
    basePort === undefined
      ? allocateProjectPorts(registry.projects, request, ranges)
      : claimProjectPorts(registry.projects, { basePort, ...request }, ranges);
  return allocation;
}

async function mutateRegistry<T>(
  config: AlprojectConfig,
  options: MutationOptions,
  mutation: (registry: Registry) => T,
): Promise<T> {
  const path = registryPath(config);
  return withRegistryLock(
    path,
    () => {
      const registry = readRegistry(config);
      const result = mutation(registry);
      writeRegistryAtomically(path, registry, options.atomicWriteOperations);
      return result;
    },
    options.lock,
  );
}

function writeRegistryAtomically(
  path: string,
  registry: Registry,
  operationOverrides: Partial<AtomicWriteOperations> = {},
): void {
  const operations = { ...atomicWriteOperations, ...operationOverrides };
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = operations.open(temporaryPath, "wx", 0o600);
    operations.write(descriptor, `${JSON.stringify(registry, undefined, 2)}\n`, "utf8");
    operations.fsync(descriptor);
    operations.close(descriptor);
    descriptor = undefined;
    operations.rename(temporaryPath, path);
    syncDirectory(dirname(path), operations);
  } catch (error) {
    if (descriptor !== undefined) tryClose(descriptor, operations.close);
    removeTemporaryFile(temporaryPath, operations.unlink);
    throw new AlprojectError(
      "registry",
      `Cannot atomically replace registry ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function syncDirectory(path: string, operations: AtomicWriteOperations): void {
  try {
    const descriptor = operations.open(path, "r");
    try {
      operations.fsync(descriptor);
    } finally {
      operations.close(descriptor);
    }
  } catch {
    // Best-effort: the rename has already succeeded, and some platforms cannot
    // open (Windows) or fsync (some filesystems) a directory.
  }
}

function tryClose(descriptor: number, close: typeof closeSync): void {
  try {
    close(descriptor);
  } catch {
    // Preserve the write error.
  }
}

function removeTemporaryFile(path: string, unlink: typeof unlinkSync): void {
  try {
    unlink(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
  }
}
