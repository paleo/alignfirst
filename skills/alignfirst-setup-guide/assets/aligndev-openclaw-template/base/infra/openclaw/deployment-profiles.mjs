#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const nativeDirectories = { claude: ".claude", codex: ".codex" };
const instructionNames = { claude: "CLAUDE.md", codex: "AGENTS.md" };
const directoryVariables = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

// This is a deployment-policy inventory, not AlignDev's runtime profile resolver.
// Existing hardening runbooks cover one agent's default native store only.
try {
  const [settingsFile, serviceHome, deployedSettingsFile] = process.argv.slice(2);
  if (settingsFile === undefined || serviceHome === undefined || deployedSettingsFile === undefined) {
    throw new Error("Usage: deployment-profiles.mjs <settings> <service-home> <deployed-settings>");
  }
  console.log(JSON.stringify(inventoryProfiles(settingsFile, serviceHome, deployedSettingsFile)));
} catch (error) {
  console.error(`[deployment profiles] ${error.message}`);
  process.exitCode = 1;
}

function inventoryProfiles(settingsFile, serviceHome, deployedSettingsFile) {
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  const code = settings.code;
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
  const selected = code.profiles[code.profile];
  if (!isObject(selected) || !Object.hasOwn(nativeDirectories, selected.agent)) {
    throw new Error("Only existing Claude/Codex deployments are supported; Pi deployment is Blocked");
  }
  const agent = selected.agent;
  const configDir = join(resolve(serviceHome), nativeDirectories[agent]);
  const profiles = Object.keys(code.profiles);
  for (const name of profiles) {
    checkProfile(name, code.profiles[name], agent, configDir, serviceHome, deployedSettingsFile);
  }
  checkDefaultProfiles(code, agent);
  rejectSymlink(configDir);
  const instructionFile = join(configDir, instructionNames[agent]);
  const skillsDir = join(configDir, "skills");
  rejectSymlink(instructionFile);
  rejectSymlink(skillsDir);
  return { profile: code.profile, agent, profiles, configDir, instructionFile, skillsDir };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkProfile(name, profile, agent, configDir, home, deployedSettingsFile) {
  if (
    name.trim() === "" ||
    /[\x00-\x1f\x7f]/u.test(name) ||
    !isObject(profile) ||
    profile.agent !== agent
  ) {
    throw new Error("Every provisioned profile must use the overlay's single Claude/Codex agent");
  }
  checkNativeStore(profile, agent, configDir, home, deployedSettingsFile);
  if (profile.quota === undefined) return;
  const quota = profile.quota;
  if (!isObject(quota) || (quota.source !== "none" && quota.source !== agent)) {
    throw new Error("Deployment quota must use the same native agent/store or source none");
  }
  if (quota.source === agent) {
    checkNativeStore(quota, agent, configDir, home, deployedSettingsFile);
  } else if (Object.keys(quota).some((key) => key !== "source")) {
    throw new Error("Disabled quota accepts only source none");
  }
}

function checkNativeStore(profile, agent, expected, home, deployedSettingsFile) {
  if (typeof profile.configDir !== "string" || profile.configDir.trim() === "") {
    throw new Error("Every deployment profile/quota store needs an explicit configDir");
  }
  const raw = profile.configDir;
  const directory = raw.startsWith("~/")
    ? resolve(home, raw.slice(2))
    : resolve(dirname(deployedSettingsFile), raw);
  if (directory !== expected) {
    throw new Error(
      "Custom native stores need a separate hardening/inventory migration; use the default store",
    );
  }
  if (
    (isObject(profile.env) && Object.hasOwn(profile.env, directoryVariables[agent])) ||
    (Array.isArray(profile.unset) && profile.unset.includes(directoryVariables[agent]))
  ) {
    throw new Error("Native directory env/unset conflicts with the deployment's explicit configDir");
  }
}

function checkDefaultProfiles(code, agent) {
  if (code.defaultProfiles === undefined) return;
  if (
    !isObject(code.defaultProfiles) ||
    Object.entries(code.defaultProfiles).some(
      ([kind, name]) =>
        kind !== agent || typeof name !== "string" || !Object.hasOwn(code.profiles, name),
    )
  ) {
    throw new Error("defaultProfiles must reference provisioned profiles of the matching agent");
  }
}

function rejectSymlink(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error("Managed native store, instruction and skills roots must not be symlinks");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
