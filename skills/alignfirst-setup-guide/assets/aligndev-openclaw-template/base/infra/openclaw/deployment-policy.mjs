#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  inventoryProfiles,
  lstatOptional,
  rejectSymlinks,
  validateInventory,
  validateManagedTree,
  within,
} from "./deployment-profiles.mjs";

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`[deployment policy] ${error.message}`);
  process.exitCode = 1;
}

function main([requestedAction, settings, home, deployed, argument, snapshotPath]) {
  if (deployed === undefined)
    throw new Error(
      "Usage: deployment-policy.mjs <prepare|validate|harden|unlock|backup|recover> <settings> <service-home> <deployed-settings> [scope|backup-directory]",
    );
  const snapshotAction = ["harden-snapshot", "unlock-snapshot"].includes(requestedAction);
  const recoveryAction = [
    "inventory-recovery",
    "validate-maintenance-recovery",
    "snapshot-recovery",
  ].includes(requestedAction);
  const action = snapshotAction
    ? requestedAction.replace("-snapshot", "")
    : recoveryAction
      ? requestedAction.replace("-recovery", "")
      : requestedAction;
  const inventory = readInventory(
    snapshotAction,
    recoveryAction || ["recover", "snapshot-backup"].includes(action),
    settings,
    home,
    deployed,
  );
  if (action === "inventory") return console.log(JSON.stringify(inventory));
  if (action === "snapshot") {
    if (argument === undefined) throw new Error("A private inventory snapshot path is required");
    return writeSnapshot(inventory, argument);
  }
  if (action === "snapshot-backup") {
    if (snapshotPath === undefined) throw new Error("A private inventory snapshot path is required");
    const { recoveryInventory } = validateRecovery(inventory, argument, settings, deployed);
    return writeSnapshot(recoveryInventory, snapshotPath);
  }
  if (action === "backup") return backup(inventory, argument);
  if (action === "recover") return recover(inventory, argument, settings, deployed);
  if (action === "validate") return;
  if (action === "validate-maintenance") return validateMaintenance(inventory, settings);
  const resources = selectResources(inventory, action, argument);
  if (action === "prepare") return prepare(inventory, resources);
  if (resources.length === 0) return;
  applyNativePolicy(action === "harden-new" ? "harden" : action, inventory, resources);
}

function writeSnapshot(inventory, path) {
  writeFileSync(path, `${JSON.stringify({ ...inventory, snapshotVersion: 1 })}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function readInventory(snapshotAction, allowMissingPackages, settings, home, deployed) {
  if (!snapshotAction)
    return inventoryProfiles(settings, home, deployed, { allowMissingPackages });
  rejectSymlinks(settings);
  const inventory = JSON.parse(readFileSync(settings, "utf8"));
  if (inventory.snapshotVersion !== 1 || inventory.serviceHome !== resolve(home))
    throw new Error("Unsupported snapshot or service home differs");
  validateInventory(inventory);
  return inventory;
}

function validateMaintenance(inventory, settings) {
  for (const name of ["seed", ".agents", ".openclaw/skills", ".openclaw/workspace"])
    rejectSymlinks(join(inventory.serviceHome, name), true);
  for (const name of [".alignfirst", ".openclaw/openclaw.json", "projects/.alignfirst-projects.json"])
    rejectSymlinks(join(inventory.serviceHome, name));
  rejectSymlinks(dirname(settings), true);
  const prefix = join(inventory.serviceHome, ".npm-system-global");
  validateManagedTree(prefix, [prefix]);
}

function selectResources(inventory, action, argument) {
  let originalResources;
  let scope = argument;
  if (action === "harden-new") {
    if (argument === undefined) throw new Error("An original inventory directory is required");
    rejectSymlinks(argument, true);
    originalResources = readdirSync(argument).flatMap((name) => {
      const snapshot = JSON.parse(readFileSync(join(argument, name), "utf8"));
      if (snapshot.snapshotVersion !== 1 || snapshot.serviceHome !== inventory.serviceHome)
        throw new Error("Unsupported original inventory snapshot");
      return snapshot.resources;
    });
    scope = undefined;
  }
  if (!["prepare", "harden", "unlock", "harden-new"].includes(action))
    throw new Error("Unknown deployment policy action");
  if (
    scope !== undefined &&
    !["instructions", "agent-config", "agent-skills"].includes(scope)
  )
    throw new Error("Unknown native maintenance scope");
  // Select complete anchors before filtering scopes: unlocking a declaration inside another
  // scope's protected tree must never thaw that tree's parent behind the other scope's back.
  return minimalResources(inventory.resources).filter(
    (resource) =>
      (scope === undefined || resource.scope === scope) &&
      !originalResources?.some((original) => within(resource.path, original.path)),
  );
}

function applyNativePolicy(action, inventory, resources) {
  if (process.getuid() !== 0) throw new Error("Hardening/unlocking requires root");
  const service = execFileSync("id", ["-gn", "{{SERVICE_USER}}"], { encoding: "utf8" }).trim();
  if (action === "harden") {
    // Reapplying policy must also work on an already hardened tree. Containment is the caller's
    // prerequisite; unlock existing nodes before ownership/mode repair, then lock descendants first.
    for (const resource of resources)
      for (const path of walkResource(resource)) command("chattr", "-i", path);
    prepare(inventory, resources);
    protectAnchors(inventory, resources, service);
  }
  let failed = false;
  // Descendants first when locking; roots first when unlocking.
  for (const resource of resources) {
    const paths = walkResource(resource);
    if (action === "harden") paths.reverse();
    for (const path of paths) {
      try {
        rejectSymlinks(path);
        if (action === "unlock") {
          command("chattr", "-i", path);
          command("chown", `{{SERVICE_USER}}:${service}`, path);
        } else {
          const stat = lstatOptional(path);
          command("chown", `root:${service}`, path);
          command(
            "chmod",
            stat.isDirectory() || (stat.mode & 0o111) !== 0
              ? "755"
              : path.endsWith(".json")
                ? "640"
                : "644",
            path,
          );
          command("chattr", "+i", path);
        }
      } catch (error) {
        failed = true;
        console.error(`[deployment policy] ${error.message}`);
        if (action === "unlock") throw error;
      }
    }
  }
  if (failed) throw new Error("Hardening incomplete; keep the gateway stopped");
}

function minimalResources(resources) {
  return resources.filter(
    (resource, index) =>
      !resources.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          within(resource.path, other.path) &&
          (resource.path !== other.path || otherIndex < index),
      ),
  );
}

function prepare(inventory, resources) {
  for (const store of inventory.stores) mkdirSync(store.configDir, { recursive: true });
  for (const resource of resources) {
    validateManagedTree(resource.path, resource.packageTree ? [resource.path] : []);
    if (lstatOptional(resource.path)) continue;
    mkdirSync(dirname(resource.path), { recursive: true });
    if (resource.kind === "file")
      writeFileSync(resource.path, resource.initial ?? "", { mode: 0o600, flag: "wx" });
    else mkdirSync(resource.path, { mode: 0o755 });
  }
}

function protectAnchors(inventory, resources, service) {
  const anchors = new Set();
  for (const path of [
    ...inventory.stores.map((store) => store.configDir),
    ...resources.map((resource) => dirname(resource.path)),
  ]) {
    let current = path;
    while (within(current, inventory.serviceHome)) {
      anchors.add(current);
      if (current === inventory.serviceHome) break;
      current = dirname(current);
    }
  }
  for (const anchor of [...anchors].sort((a, b) => a.length - b.length)) {
    rejectSymlinks(anchor);
    // Root-owned sticky writable anchors prevent the service account from renaming managed
    // root-owned children, while auth.json, adjacent locks and ordinary new files stay writable.
    command("chattr", "-i", anchor);
    command("chown", `root:${service}`, anchor);
    command("chmod", "1770", anchor);
  }
  for (const store of inventory.stores.filter((item) => item.agent === "pi")) {
    const auth = join(store.configDir, "auth.json");
    if (!lstatOptional(auth)) continue;
    rejectSymlinks(auth);
    command("chown", `{{SERVICE_USER}}:${service}`, auth);
    command("chmod", "600", auth);
  }
}

function walkResource(resource) {
  return walk(resource.path, resource.packageTree ? [resource.path] : []);
}

function walk(path, packageRoots = []) {
  validateManagedTree(path, packageRoots);
  return physicalPaths(path);
}

function physicalPaths(path) {
  const stat = lstatOptional(path);
  if (!stat || stat.isSymbolicLink()) return [];
  return [
    path,
    ...(stat.isDirectory()
      ? readdirSync(path).flatMap((name) => physicalPaths(join(path, name)))
      : []),
  ];
}

function command(name, ...args) {
  execFileSync(name, args, { stdio: ["ignore", "ignore", "pipe"] });
}

function backup(inventory, destination) {
  if (destination === undefined) throw new Error("A private backup directory is required");
  const root = resolve(destination);
  rejectSymlinks(root, true);
  if (
    [...inventory.stores.map((store) => store.configDir), ...inventory.resources.map((item) => item.path)]
      .some((path) => within(root, path) || within(path, root))
  )
    throw new Error("Backup overlaps a native store or managed resource");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const mapping = inventory.stores.map((store, index) => ({
    agent: store.agent,
    destination: store.configDir,
    source: `store-${index}`,
    present: lstatOptional(store.configDir) !== undefined,
    executables: walk(
      store.configDir,
      inventory.resources.filter((item) => item.packageTree).map((item) => item.path),
    )
      .filter((path) => lstatOptional(path).isFile() && (lstatOptional(path).mode & 0o111) !== 0)
      .map((path) => path.slice(store.configDir.length + 1)),
  }));
  for (const entry of mapping) {
    if (entry.present) copyBackup(entry.destination, join(root, entry.source));
  }
  const resources = externalResources(inventory).map((resource, index) => ({
    destination: resource.path,
    source: `resource-${index}`,
    directory: lstatOptional(resource.path)?.isDirectory() ?? resource.kind !== "file",
    present: lstatOptional(resource.path) !== undefined,
    executables: walkResource(resource)
      .filter((path) => lstatOptional(path).isFile() && (lstatOptional(path).mode & 0o111) !== 0)
      .map((path) => (path === resource.path ? "." : path.slice(resource.path.length + 1))),
  }));
  for (const entry of resources) {
    if (entry.present) copyBackup(entry.destination, join(root, entry.source));
  }
  // Session transcripts and credentials never inherit publicly readable source modes.
  for (const path of walk(root, [root]))
    chmodSync(path, lstatOptional(path).isDirectory() ? 0o700 : 0o600);
  writeFileSync(
    join(root, "mapping.json"),
    `${JSON.stringify({ version: 1, stores: mapping, resources }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
}

function copyBackup(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
  // Absolute contained links must not point back to the live store from the private backup.
  function relocate(path) {
    const stat = lstatOptional(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (isAbsolute(target)) {
        // Containment was validated component by component. Resolve the original physical target:
        // lexical normalization of an intermediate symlink followed by '..' changes its identity.
        const physicalTarget = realpathSync.native(join(source, relative(destination, path)));
        if (!within(physicalTarget, source)) throw new Error("Backup link escapes its source");
        const copiedTarget = join(destination, relative(source, physicalTarget));
        rmSync(path);
        symlinkSync(relative(dirname(path), copiedTarget), path);
      }
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path)) relocate(join(path, name));
    }
  }
  relocate(destination);
}

function recover(inventory, source, settings, deployed) {
  const { root, manifest } = validateRecovery(inventory, source, settings, deployed);
  for (const [index, entry] of manifest.stores.entries()) {
    const destination = inventory.stores[index].configDir;
    clearDestination(destination, true);
    if (!entry.present) continue;
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    cpSync(join(root, entry.source), destination, { recursive: true, verbatimSymlinks: true });
    for (const path of entry.executables) chmodSync(join(destination, path), 0o700);
  }
  for (const entry of manifest.resources) {
    clearDestination(entry.destination, entry.present && entry.directory);
    if (!entry.present) continue;
    mkdirSync(dirname(entry.destination), { recursive: true });
    cpSync(join(root, entry.source), entry.destination, { recursive: true, verbatimSymlinks: true });
    for (const path of entry.executables)
      chmodSync(path === "." ? entry.destination : join(entry.destination, path), 0o700);
  }
  // The root wrapper restores ownership/immutable policy even when service recovery fails.
}

function validateRecovery(inventory, source, settings, deployed) {
  if (source === undefined) throw new Error("A private backup directory is required");
  const root = resolve(source);
  rejectSymlinks(root);
  rejectSymlinks(join(root, "mapping.json"));
  const manifest = JSON.parse(readFileSync(join(root, "mapping.json"), "utf8"));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.stores) ||
    manifest.stores.length !== inventory.stores.length
  )
    throw new Error("Backup mapping does not match provisioned native stores");
  // Validate every mapping before writing anything. Never trust arbitrary restore destinations.
  for (const [index, entry] of manifest.stores.entries()) {
    const store = inventory.stores[index];
    if (
      entry.destination !== store.configDir ||
      entry.agent !== store.agent ||
      entry.source !== `store-${index}` ||
      typeof entry.present !== "boolean"
    )
      throw new Error("Backup destination mapping differs from protected settings");
    if (entry.present && !lstatOptional(join(root, entry.source))?.isDirectory())
      throw new Error("Missing backup native store");
    if (!Array.isArray(entry.executables)) throw new Error("Missing executable mode mapping");
    for (const path of entry.executables) {
      const target = typeof path === "string" ? resolve(root, entry.source, path) : root;
      if (
        typeof path !== "string" ||
        isAbsolute(path) ||
        path.split("/").includes("..") ||
        !within(target, join(root, entry.source)) ||
        target === join(root, entry.source) ||
        !lstatOptional(target)?.isFile()
      )
        throw new Error("Invalid executable mode mapping");
    }
    if (within(root, store.configDir) || within(store.configDir, root))
      throw new Error("Recovery overlaps native store");
  }
  // Resource declarations come from the backed-up native settings when that store was lost.
  // Destinations still resolve against the protected deployment profile's original native root.
  const nativeSettingsRoots = new Map(
    manifest.stores
      .filter((entry) => entry.present)
      .map((entry) => [entry.destination, join(root, entry.source)]),
  );
  const recoveryInventory = inventoryProfiles(settings, inventory.serviceHome, deployed, {
    nativeSettingsRoots,
    allowMissingPackages: true,
  });
  const resources = externalResources(recoveryInventory);
  if (!Array.isArray(manifest.resources) || manifest.resources.length !== resources.length)
    throw new Error("Backup resource inventory differs from protected settings");
  for (const [index, entry] of manifest.resources.entries()) {
    const resource = resources[index];
    if (
      entry.destination !== resource.path ||
      entry.source !== `resource-${index}` ||
      typeof entry.present !== "boolean" ||
      typeof entry.directory !== "boolean" ||
      !Array.isArray(entry.executables)
    )
      throw new Error("Invalid external resource mapping");
    const target = join(root, entry.source);
    if (entry.present && lstatOptional(target)?.isDirectory() !== entry.directory)
      throw new Error("Missing backup resource");
    if (within(root, resource.path) || within(resource.path, root))
      throw new Error("Backup overlaps managed resources");
    for (const path of entry.executables) {
      const executable = typeof path === "string" ? resolve(target, path) : root;
      if (
        typeof path !== "string" || isAbsolute(path) || path.split("/").includes("..") ||
        !within(executable, target) || !lstatOptional(executable)?.isFile()
      )
        throw new Error("Invalid external executable mapping");
    }
  }
  // Validate every source against its restored package anchors before changing any destination.
  for (const entry of [...manifest.stores, ...manifest.resources]) {
    const sourceRoot = join(root, entry.source);
    const packageRoots = recoveryInventory.resources
      .filter((item) => item.packageTree && within(item.path, entry.destination))
      .map((item) => resolve(sourceRoot, relative(entry.destination, item.path)));
    validateManagedTree(sourceRoot, packageRoots);
    validateRelativeBackupLinks(sourceRoot);
    rejectSymlinks(entry.destination);
    if (!entry.present && lstatOptional(sourceRoot))
      throw new Error("Unexpected absent backup source");
  }
  return { root, manifest, recoveryInventory };
}

function validateRelativeBackupLinks(path) {
  const stat = lstatOptional(path);
  if (stat?.isSymbolicLink() && isAbsolute(readlinkSync(path)))
    throw new Error("Backup package links must be relative to survive relocation safely");
  if (stat?.isDirectory())
    for (const name of readdirSync(path)) validateRelativeBackupLinks(join(path, name));
}

function clearDestination(path, directory) {
  const stat = lstatOptional(path);
  if (stat?.isDirectory() && directory) {
    // Keep sticky, root-owned native anchors; replace their contents, never merge executable state.
    for (const name of readdirSync(path)) rmSync(join(path, name), { recursive: true, force: true });
  } else if (stat) rmSync(path, { recursive: stat.isDirectory() });
}

function externalResources(inventory) {
  return minimalResources(
    inventory.resources.filter(
      (resource) => !inventory.stores.some((store) => within(resource.path, store.configDir)),
    ),
  );
}
