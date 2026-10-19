#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const nativeDirectories = { claude: ".claude", codex: ".codex", pi: ".pi/agent" };
const instructionNames = { claude: "CLAUDE.md", codex: "AGENTS.md", pi: "AGENTS.md" };
const directoryVariables = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  pi: "PI_CODING_AGENT_DIR",
};
const piFiles = [
  "settings.json",
  "models.json",
  "mcp.json",
  "keybindings.json",
  "trust.json",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
];
const piTrees = ["extensions", "skills", "prompts", "themes", "npm", "git", "agents", "bin"];

if (resolve(process.argv[1] ?? ".") === fileURLToPath(import.meta.url)) {
  try {
    const [settings, home, deployed] = process.argv.slice(2);
    if (deployed === undefined)
      throw new Error(
        "Usage: deployment-profiles.mjs <settings> <service-home> <deployed-settings>",
      );
    console.log(JSON.stringify(inventoryProfiles(settings, home, deployed)));
  } catch (error) {
    console.error(`[deployment profiles] ${error.message}`);
    process.exitCode = 1;
  }
}

// Deployment inventory deliberately does not reproduce runtime profile selection.
export function inventoryProfiles(settingsFile, serviceHome, deployedSettingsFile, options = {}) {
  const home = resolve(serviceHome);
  rejectSymlinks(home);
  rejectSymlinks(settingsFile);
  rejectSymlinks(deployedSettingsFile);
  const code = JSON.parse(readFileSync(settingsFile, "utf8")).code;
  if (
    !isObject(code) ||
    Object.keys(code).some((key) => !["profile", "profiles", "defaultProfiles"].includes(key))
  ) {
    throw new Error(
      `${settingsFile}: use code.profile and code.profiles; direct launch keys are retired`,
    );
  }
  if (
    !isObject(code.profiles) ||
    typeof code.profile !== "string" ||
    !Object.hasOwn(code.profiles, code.profile)
  ) {
    throw new Error(`${settingsFile}: an explicit code.profile must name a provisioned profile`);
  }
  const stores = [];
  for (const [name, profile] of Object.entries(code.profiles)) {
    if (name.trim() === "" || /[\x00-\x1f\x7f]/u.test(name) || !isObject(profile))
      throw new Error("Invalid deployment profile");
    addStore(stores, name, profile.agent, profile, home, deployedSettingsFile);
    const quota = profile.quota;
    if (quota === undefined) continue;
    if (!isObject(quota) || !["claude", "codex", "none"].includes(quota.source))
      throw new Error("Invalid quota source");
    if (quota.source === "none") {
      if (Object.keys(quota).length !== 1)
        throw new Error("Disabled quota accepts only source none");
    } else {
      addStore(stores, name, quota.source, quota, home, deployedSettingsFile);
    }
  }
  if (code.defaultProfiles !== undefined) {
    if (!isObject(code.defaultProfiles)) throw new Error("Invalid defaultProfiles");
    for (const [agent, name] of Object.entries(code.defaultProfiles)) {
      if (!Object.hasOwn(nativeDirectories, agent) || code.profiles[name]?.agent !== agent)
        throw new Error("defaultProfiles must reference a matching provisioned profile");
    }
  }
  for (const store of stores) {
    rejectSymlinks(store.configDir);
    for (const other of stores) {
      if (
        store !== other &&
        (within(store.configDir, other.configDir) || within(other.configDir, store.configDir))
      )
        throw new Error("Overlapping native stores are unsafe");
    }
  }
  const resources = stores.flatMap((store) => storeResources(store, home, options));
  if (stores.some((store) => store.agent === "pi")) {
    resources.push({ path: join(home, ".agents/skills"), kind: "tree", scope: "agent-skills" });
    // Context discovery also visits HOME and intermediate parents regardless of project trust.
    const ancestors = new Set([home]);
    for (const store of stores.filter((item) => item.agent === "pi")) {
      let path = dirname(store.configDir);
      while (within(path, home)) {
        ancestors.add(path);
        if (path === home) break;
        path = dirname(path);
      }
    }
    for (const ancestor of ancestors) {
      for (const name of [
        "AGENTS.override.md",
        "AGENTS.md",
        "AGENTS.MD",
        "CLAUDE.md",
        "CLAUDE.MD",
      ]) {
        const path = join(ancestor, name);
        resources.push({
          path,
          kind: lstatOptional(path)?.isFile() ? "file" : "sentinel",
          scope: "instructions",
        });
      }
    }
  }
  validateInventory({ resources, stores, serviceHome: home });
  const selected = stores.find(
    (store) =>
      store.agent === code.profiles[code.profile].agent && store.profiles.includes(code.profile),
  );
  return {
    ...selected,
    profile: code.profile,
    profiles: Object.keys(code.profiles),
    stores,
    resources,
    serviceHome: home,
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addStore(stores, name, agent, profile, home, deployed) {
  if (!Object.hasOwn(nativeDirectories, agent)) throw new Error("Unsupported coding agent");
  if (typeof profile.configDir !== "string" || profile.configDir.trim() === "")
    throw new Error("Every deployment profile/quota store needs an explicit configDir");
  if (
    (isObject(profile.env) && Object.hasOwn(profile.env, directoryVariables[agent])) ||
    profile.unset?.includes(directoryVariables[agent])
  )
    throw new Error("Native directory env/unset conflicts with explicit configDir");
  // HOME and alternate session roots would invalidate this filesystem inventory.
  for (const key of ["HOME", "PI_CODING_AGENT_SESSION_DIR"]) {
    if (Object.hasOwn(profile.env ?? {}, key) || profile.unset?.includes(key))
      throw new Error(`Deployment inventory forbids ${key} overrides`);
  }
  const configDir = expandPath(profile.configDir, home, dirname(deployed));
  if (
    !within(configDir, home) ||
    configDir === home ||
    [
      ".alignfirst",
      ".openclaw",
      "seed",
      "projects",
      "backups",
      ".agents",
      ".npm-system-global",
    ].some((part) => within(configDir, join(home, part)) || within(join(home, part), configDir))
  )
    throw new Error("Native stores must be isolated beneath the service home");
  const existing = stores.find((store) => store.configDir === configDir);
  if (existing) {
    if (existing.agent !== agent) throw new Error("Different agents cannot share a native store");
    if (!existing.profiles.includes(name)) existing.profiles.push(name);
    return;
  }
  const instructions =
    agent === "pi"
      ? (["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"].find((file) =>
          lstatOptional(join(configDir, file))?.isFile(),
        ) ?? "AGENTS.md")
      : instructionNames[agent];
  stores.push({
    agent,
    configDir,
    profiles: [name],
    instructionFile: join(configDir, instructions),
    skillsDir: join(configDir, "skills"),
  });
}

function expandPath(path, home, base) {
  rejectAmbiguousPath(path);
  if (path.startsWith("~") && !path.startsWith("~/"))
    throw new Error("Unsupported deployment path");
  return path.startsWith("~/") ? resolve(home, path.slice(2)) : resolve(base, path);
}

function rejectAmbiguousPath(path) {
  // Native loaders trim, decode file URLs and sometimes normalize Unicode spaces. A deployment
  // accepts only unambiguous filesystem spellings, before creating or thawing any managed path.
  if (
    path === "" ||
    path !== path.trim() ||
    /[\x00-\x1f\x7f\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(path) ||
    /^file:/iu.test(path)
  )
    throw new Error("Ambiguous native resource path; use a plain, unpadded filesystem path");
}

export function within(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function storeResources(store, home, options) {
  const resource = (name, kind, scope, initial) => ({
    path: join(store.configDir, name),
    kind,
    scope,
    ...(initial === undefined ? {} : { initial }),
  });
  if (store.agent !== "pi")
    return [
      resource(instructionNames[store.agent], "file", "instructions", ""),
      resource("skills", "tree", "agent-skills"),
    ];
  const resources = piFiles.map((name) => {
    const context = /^(AGENTS|CLAUDE)\./u.test(name);
    const path = join(store.configDir, name);
    const sentinel = context && path !== store.instructionFile && !lstatOptional(path)?.isFile();
    return resource(
      name,
      sentinel ? "sentinel" : "file",
      /\.md$/iu.test(name) ? "instructions" : "agent-config",
      name.endsWith(".json") ? "{}\n" : "",
    );
  });
  // Directory sentinels are skipped by the context loader; empty override files are not neutral.
  resources.push(
    resource(
      "AGENTS.override.md",
      lstatOptional(join(store.configDir, "AGENTS.override.md"))?.isFile() ? "file" : "sentinel",
      "instructions",
    ),
  );
  resources.push(
    ...piTrees.map((name) => ({
      ...resource(name, "tree", name === "skills" ? "agent-skills" : "agent-config"),
      ...(["npm", "git"].includes(name) ? { packageTree: true } : {}),
    })),
  );
  const settingsPath = join(
    options.nativeSettingsRoots?.get(store.configDir) ?? store.configDir,
    "settings.json",
  );
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (settings.sessionDir !== undefined)
    throw new Error("Managed Pi sessionDir overrides need a separate backup policy");
  for (const kind of ["extensions", "skills", "prompts", "themes", "packages"]) {
    for (const entry of settings[kind] ?? []) {
      const raw = typeof entry === "string" ? entry : entry.source;
      if (typeof raw !== "string") throw new Error("Invalid Pi resource declaration");
      rejectAmbiguousPath(raw);
      if (raw.startsWith("builtin:") || /^[+-]builtin:/u.test(raw)) continue;
      if (kind === "packages" && raw.startsWith("npm:")) {
        const name = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@[^/]+)?$/u.exec(raw)?.[1];
        const installation =
          name === undefined
            ? undefined
            : lstatOptional(join(store.configDir, "npm/node_modules", name));
        if (
          name === undefined ||
          (installation === undefined
            ? !options.allowMissingPackages
            : !installation.isDirectory())
        )
          throw new Error(
            "Install declared npm packages in the managed agent npm directory before hardening; legacy global fallback is unsupported",
          );
        continue;
      }
      if (kind === "packages" && /^(git:|https?:)/u.test(raw)) continue;
      if (raw.startsWith("!") || raw.startsWith("-")) continue;
      const path = expandPath(raw.replace(/^\+/u, ""), home, store.configDir);
      if (/[*?{}[\]]/u.test(path))
        throw new Error("Use concrete managed resource roots instead of globs");
      if (!within(path, home))
        throw new Error("Managed local resources must be beneath the service home");
      if (!resources.some((resource) => within(path, resource.path)))
        resources.push({
          path,
          kind: lstatOptional(path)?.isFile() ? "file" : "tree",
          scope: kind === "skills" ? "agent-skills" : "agent-config",
          ...(kind === "packages" ? { packageTree: true } : {}),
        });
    }
  }
  return resources;
}

export function validateInventory({ resources, stores, serviceHome: home }) {
  const packageRoots = resources.filter((item) => item.packageTree).map((item) => item.path);
  for (const store of stores) {
    rejectSymlinks(store.configDir);
    validateManagedTree(store.configDir, packageRoots);
  }
  for (const resource of resources) {
    rejectSymlinks(resource.path);
    validateManagedTree(resource.path, resource.packageTree ? [resource.path] : []);
    validatePackageManifests(resource.path);
    if (
      resources.some((other) => other.path !== resource.path && within(resource.path, other.path))
    )
      throw new Error("Overlapping managed resource anchors are unsafe");
    if (
      [
        ".alignfirst",
        ".openclaw",
        "seed",
        "projects",
        "backups",
        ".npm-system-global",
        ".cache",
        ".local/share/fnm",
      ].some((name) => within(resource.path, join(home, name)))
    )
      throw new Error("Managed resources overlap deployment runtime state");
    for (const store of stores) {
      if (
        within(store.configDir, resource.path) ||
        ["auth.json", "sessions", "cache"].some((name) =>
          within(resource.path, join(store.configDir, name)),
        )
      )
        throw new Error("Managed resource overlaps mutable native state");
    }
  }
}

function validatePackageManifests(path) {
  const stat = lstatOptional(path);
  if (!stat?.isDirectory()) return;
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (name !== "package.json") {
      if (lstatOptional(child)?.isDirectory()) validatePackageManifests(child);
      continue;
    }
    const manifest = JSON.parse(readFileSync(child, "utf8")).pi;
    if (manifest === undefined) continue;
    for (const kind of ["extensions", "skills", "prompts", "themes"]) {
      for (const entry of manifest[kind] ?? []) {
        if (typeof entry !== "string") throw new Error("Invalid Pi package manifest resource");
        rejectAmbiguousPath(entry);
        const pattern = entry.replace(/^[!+-]/u, "");
        rejectAmbiguousPath(pattern);
        if (pattern.split("/").includes("..") || !within(resolve(path, pattern), path))
          throw new Error(
            "Pi package manifest resources must stay inside their protected package tree",
          );
      }
    }
  }
}

// Package links are allowed only below a real protected anchor. Validate every target component,
// including intermediate symlinks and '..', without letting normalization conceal an escape.
export function validateManagedTree(path, packageRoots = []) {
  const root = packageRoots.find((candidate) => path !== candidate && within(path, candidate));
  const stat = lstatOptional(path);
  if (stat?.isSymbolicLink()) {
    if (root === undefined) throw new Error(`Refusing symlink: ${path}`);
    resolveContainedLink(path, root);
    return;
  }
  rejectSymlinks(path);
  if (stat?.isDirectory())
    for (const entry of readdirSync(path)) validateManagedTree(join(path, entry), packageRoots);
}

function resolveContainedLink(path, root) {
  rejectSymlinks(root);
  let current = root;
  const pending = relative(root, path).split("/");
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift();
    if (part === "" || part === ".") continue;
    current = part === ".." ? dirname(current) : join(current, part);
    if (!within(current, root)) throw new Error(`Package link escapes managed root: ${path}`);
    const stat = lstatOptional(current);
    if (!stat) throw new Error(`Dangling package link: ${path}`);
    if (!stat.isSymbolicLink()) {
      if (!stat.isDirectory() && pending.length > 0)
        throw new Error(`Invalid package link chain: ${path}`);
      if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Refusing special file: ${current}`);
      if (stat.isFile() && stat.nlink !== 1) throw new Error(`Refusing hard-linked file: ${current}`);
      continue;
    }
    if (++links > 40) throw new Error(`Cyclic package link: ${path}`);
    const target = readlinkSync(current);
    const base = dirname(current);
    if (isAbsolute(target)) {
      if (!within(target, root)) throw new Error(`Package link escapes managed root: ${path}`);
      current = root;
      pending.unshift(...target.slice(root.length + 1).split("/"));
    } else {
      current = base;
      pending.unshift(...target.split("/"));
    }
  }
}

export function rejectSymlinks(path, recursive = false) {
  let ancestor = resolve(path);
  while (true) {
    if (lstatOptional(ancestor)?.isSymbolicLink()) throw new Error(`Refusing symlink: ${ancestor}`);
    if (dirname(ancestor) === ancestor) break;
    ancestor = dirname(ancestor);
  }
  const stat = lstatOptional(path);
  if (stat && !stat.isFile() && !stat.isDirectory())
    throw new Error(`Refusing special file: ${path}`);
  if (stat?.isFile() && stat.nlink !== 1) throw new Error(`Refusing hard-linked file: ${path}`);
  if (recursive && stat?.isDirectory())
    for (const entry of readdirSync(path)) rejectSymlinks(join(path, entry), true);
}

export function lstatOptional(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
