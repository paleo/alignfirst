import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "packages");
// A package awaiting its first release sits at this placeholder until Changesets bumps it.
// The registry has no such version, so without this guard it reads as a pending release.
const UNRELEASED_VERSION = "0.0.0";

console.log(JSON.stringify(findPendingReleases()));

function findPendingReleases() {
  const pending = [];
  for (const { name, version } of readPublicManifests()) {
    if (version === UNRELEASED_VERSION) continue;
    if (!publishedVersions(name).includes(version)) pending.push(`${name}@${version}`);
  }
  return pending;
}

function readPublicManifests() {
  const manifests = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, entry.name, "package.json"), "utf8"),
    );
    if (manifest.private !== true) manifests.push(manifest);
  }
  return manifests;
}

function publishedVersions(name) {
  let stdout;
  try {
    stdout = execFileSync("npm", ["view", name, "versions", "--json"], { encoding: "utf8" });
  } catch (error) {
    if (isUnpublishedPackage(error)) return [];
    throw error;
  }
  const versions = JSON.parse(stdout);
  return Array.isArray(versions) ? versions : [versions];
}

function isUnpublishedPackage(error) {
  if (typeof error.stdout !== "string") return false;
  try {
    return JSON.parse(error.stdout).error?.code === "E404";
  } catch {
    return false;
  }
}
