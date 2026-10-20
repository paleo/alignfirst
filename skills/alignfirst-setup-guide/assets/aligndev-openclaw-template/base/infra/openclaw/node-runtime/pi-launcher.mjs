#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "@earendil-works/pi-coding-agent";
const minimumNode = [22, 19, 0];

if (resolve(process.argv[1] ?? ".") === fileURLToPath(import.meta.url)) {
  try {
    const [packageRoot, version, prefix] = process.argv.slice(2);
    if (prefix === undefined)
      throw new Error("Usage: pi-launcher.mjs <package-root> <exact-version> <protected-prefix>");
    if (!resolve(packageRoot).startsWith(`${resolve(prefix)}/`))
      throw new Error("Pi package must be inside the protected prefix");
    verifyProtectedPrefix(prefix);
    process.stdout.write(renderPiLauncher(packageRoot, version));
  } catch (error) {
    console.error(`[Pi launcher] ${error.message}`);
    process.exitCode = 1;
  }
}

export function renderPiLauncher(packageRoot, version, nodeVersion = process.versions.node) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version))
    throw new Error("An exact reviewed Pi release version is required");
  const root = resolve(packageRoot);
  rejectSymlinks(root);
  const manifestPath = join(root, "package.json");
  rejectSymlinks(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== packageName || manifest.version !== version)
    throw new Error("Installed Pi package name/version differs from the reviewed pin");
  const bin = manifest.bin?.pi;
  if (typeof bin !== "string" || bin === "" || isAbsolute(bin) || /[\x00-\x1f\x7f]/u.test(bin))
    throw new Error("Installed Pi package must declare a relative bin.pi entry");
  const entry = resolve(root, bin);
  if (!entry.startsWith(`${root}/`)) throw new Error("Pi bin.pi escapes its package");
  rejectSymlinks(entry);
  if (!lstatSync(entry).isFile()) throw new Error("Pi bin.pi is not a regular file");
  verifyNode(nodeVersion, manifest.engines?.node);
  return `#!/bin/sh\nexec /usr/bin/node ${shellQuote(entry)} "$@"\n`;
}

function rejectSymlinks(path) {
  let current = path;
  while (true) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlinked Pi entry path: ${current}`);
    if (current === dirname(current)) return;
    current = dirname(current);
  }
}

function verifyNode(version, requirement) {
  const current = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  const declared = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(requirement ?? "");
  if (!current || !declared)
    throw new Error("Cannot verify Pi's Node requirement; review its engines.node before installing");
  for (const floor of [minimumNode, declared.slice(1).map(Number)]) {
    const actual = current.slice(1).map(Number);
    const difference = actual.findIndex((value, index) => value !== floor[index]);
    if (difference !== -1 && actual[difference] < floor[difference])
      throw new Error(`System Node ${version} is unsupported; Pi/extensions require >=${floor.join(".")}`);
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function verifyProtectedPrefix(prefix) {
  const root = resolve(prefix);
  rejectSymlinks(root);
  verifyProtectedPath(root, root);
}

function verifyProtectedPath(path, root) {
  const stat = lstatSync(path);
  if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0))
    throw new Error(`Pi package prefix is not root-owned/protected: ${path}`);
  if (stat.isSymbolicLink()) {
    if (!realpathSync(path).startsWith(`${root}/`))
      throw new Error(`Pi package link escapes protected prefix: ${path}`);
    return;
  }
  if (stat.isDirectory())
    for (const name of readdirSync(path)) verifyProtectedPath(join(path, name), root);
}
