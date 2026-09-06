#!/usr/bin/env node
// Build and pack the local @paleo/openclaw-* workspace packages into ./vendor/*.tgz.
//
// alignfirst-developer-tests is a standalone consumer (not a root workspace member) whose
// Docker image installs these packages via `npm ci` at build time. Pulling them
// from npmjs means the harness always lags a publish — a recurring problem while
// iterating on the mocks (e.g. an OpenClaw SDK port that isn't released yet).
// Vendoring the freshly-built tarballs into the build context makes the image
// test *this* checkout, no publish required. Run before `npm install` /
// `env:build` (npm's `env:build` script chains this automatically).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const CONSUMER_DIR = resolve(HERE, "..");
const VENDOR_DIR = resolve(HERE, "../vendor");
const LOCK_PATH = resolve(CONSUMER_DIR, "package-lock.json");

// Build order matters: the mock wrappers and harness resolve types from
// channel-mock-core's dist, so it is built (and listed) first.
const PACKAGES = [
  { name: "@paleo/openclaw-channel-mock-core", tarball: "openclaw-channel-mock-core.tgz" },
  { name: "@paleo/openclaw-discord-mock", tarball: "openclaw-discord-mock.tgz" },
  { name: "@paleo/openclaw-slack-mock", tarball: "openclaw-slack-mock.tgz" },
  { name: "@paleo/openclaw-thread-handoff", tarball: "openclaw-thread-handoff.tgz" },
  { name: "@paleo/openclaw-test", tarball: "openclaw-test.tgz" },
];

vendorPackages();

function vendorPackages() {
  resetVendorDir();
  buildPackages();
  for (const pkg of PACKAGES) packPackage(pkg);
  invalidateVendoredDependencies();
  console.log(`Vendored ${PACKAGES.length} package(s) into ${VENDOR_DIR}`);
}

// A vendored tarball keeps the same version (e.g. 0.12.0) across edits, so a subsequent
// `npm install` reuses both the installed copy and its locked integrity. Remove both cached records
// so the install following `vendor` reads and locks the new archive.
function invalidateVendoredDependencies() {
  removeStaleLockEntries();
  for (const pkg of PACKAGES) {
    rmSync(resolve(CONSUMER_DIR, "node_modules", pkg.name), { recursive: true, force: true });
  }
}

function removeStaleLockEntries() {
  if (!existsSync(LOCK_PATH)) return;
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  if (!lock.packages || typeof lock.packages !== "object") return;
  for (const pkg of PACKAGES) delete lock.packages[`node_modules/${pkg.name}`];
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
}

function resetVendorDir() {
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });
}

function buildPackages() {
  const workspaceArgs = PACKAGES.flatMap((pkg) => ["--workspace", pkg.name]);
  run("npm", ["run", "build", ...workspaceArgs]);
}

function packPackage({ name, tarball }) {
  const out = run("npm", ["pack", "--workspace", name, "--pack-destination", VENDOR_DIR, "--json"]);
  const [{ filename }] = JSON.parse(out);
  renameSync(resolve(VENDOR_DIR, filename), resolve(VENDOR_DIR, tarball));
}

function run(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}
