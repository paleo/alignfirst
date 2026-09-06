import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const installRoot = mkdtempSync(join(tmpdir(), "alignfirst-release-"));

try {
  smokeTestRelease();
} finally {
  rmSync(installRoot, { force: true, recursive: true });
}

function smokeTestRelease() {
  const docmap = packWorkspace("docmap");
  const alignfirst = packWorkspace("alignfirst");
  writeFileSync(join(installRoot, "package.json"), '{"private":true}\n');
  runNpm(["install", "--ignore-scripts", "--omit=peer", docmap.tarball, alignfirst.tarball]);
  verifyCliVersion(["--version"], alignfirst.version);
  verifyCliVersion(["docmap", "--version"], docmap.version);
  console.log(`Release smoke test passed for alignfirst@${alignfirst.version}.`);
}

function packWorkspace(directory) {
  const packageRoot = join(repositoryRoot, "packages", directory);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const output = runNpm(["pack", "--json", "--pack-destination", installRoot], packageRoot);
  const filename = JSON.parse(output)[0]?.filename;
  if (typeof manifest.version !== "string" || typeof filename !== "string") {
    throw new Error(`Could not pack packages/${directory}.`);
  }
  return { tarball: join(installRoot, filename), version: manifest.version };
}

function verifyCliVersion(args, expected) {
  const executable = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "alignfirst.cmd" : "alignfirst",
  );
  const actual = execFileSync(executable, args, { cwd: installRoot, encoding: "utf8" }).trim();
  if (actual !== expected) {
    throw new Error(`Expected ${expected} from alignfirst ${args.join(" ")}, received ${actual}.`);
  }
}

function runNpm(args, cwd = installRoot) {
  return execFileSync("npm", args, { cwd, encoding: "utf8" });
}
