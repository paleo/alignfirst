import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPackedFilename } from "./npm-pack.mjs";
import { verifyPackagedWorkspaces } from "./test/packaged-workspace-acceptance.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const installRoot = mkdtempSync(join(tmpdir(), "alignfirst-release-"));

try {
  smokeTestRelease();
  rmSync(installRoot, { force: true, recursive: true });
} catch (error) {
  console.error(
    `Release smoke failed; retained owned fixtures/tarballs for recovery: ${installRoot}`,
  );
  throw error;
}

function smokeTestRelease() {
  assert(
    process.argv.slice(2).every((arg) => arg === "--cli-only"),
    "Unknown smoke option",
  );
  const [docmap, workspace, alignfirst, aligndev] = [
    "docmap",
    "workspace",
    "alignfirst",
    "aligndev",
  ].map(packWorkspace);
  const cliRoot = disposableInstall("cli", [docmap, workspace, alignfirst, aligndev]);
  for (const packed of [docmap, workspace, alignfirst, aligndev]) {
    assert.equal(installedManifest(cliRoot, packed.name).version, packed.version);
    const installed = join(cliRoot, "node_modules", packed.name);
    assert.equal(realpathSync(installed), installed, `${packed.name} must come from its tarball`);
  }
  verifyCliVersion(cliRoot, "alignfirst", ["--version"], alignfirst.version);
  verifyCliVersion(cliRoot, "alignfirst", ["docmap", "--version"], docmap.version);
  verifyCliVersion(cliRoot, "aligndev", ["--version"], aligndev.version);
  verifyCliVersion(cliRoot, "docmap", ["--version"], docmap.version);
  verifyInvocationConsumers(cliRoot);
  verifyPackagedWorkspaces({
    executable: process.execPath,
    entry: join(cliRoot, "node_modules/alignfirst/bin/alignfirst.mjs"),
    root: installRoot,
    env: isolatedEnvironment(cliRoot),
    evidence: process.env.PACKAGED_WORKSPACE_EVIDENCE,
  });
  console.log(
    `CLI release smoke passed: docmap@${docmap.version}, workspace@${workspace.version}, alignfirst@${alignfirst.version}, aligndev@${aligndev.version}.`,
  );
  if (process.argv.includes("--cli-only")) return;
  const [subagent, background] = ["pi-subagent", "pi-background"].map(packWorkspace);
  // Separate installs prove that each extension installs and loads without the other.
  for (const packed of [subagent, background]) {
    const root = disposableInstall(packed.name.split("/").at(-1), [packed], true);
    const directory = join(root, "node_modules", packed.name);
    assert(!existsSync(join(directory, "node_modules")), "No bundled host/sibling copies");
    assert(!existsSync(join(root, "node_modules/alignfirst")));
    assert(!existsSync(join(root, "node_modules/aligndev")));
    for (const script of ["pi-packed-smoke.mjs", "pi-smoke-provider.mjs"])
      copyFileSync(join(repositoryRoot, "scripts", script), join(root, script));
    execFileSync(process.execPath, [join(root, "pi-packed-smoke.mjs"), packed.name], {
      cwd: root,
      env: isolatedEnvironment(root),
      stdio: "inherit",
      timeout: 120000,
    });
  }
  console.log(
    `Release smoke passed: alignfirst@${alignfirst.version}, aligndev@${aligndev.version}, Pi 1.4.0, each extension independently.`,
  );
}

function verifyInvocationConsumers(root) {
  execFileSync(
    process.execPath,
    [
      "--experimental-import-meta-resolve",
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import { realpathSync } from "node:fs";
       import { join } from "node:path";
       import { fileURLToPath, pathToFileURL } from "node:url";
       import { createCommand, renderCommand } from "@alignfirst/docmap/invocation";
       assert.equal(renderCommand(createCommand("bunx", ["--bun", "alignfirst"])),
         "bunx --bun alignfirst");
       assert.equal(realpathSync(fileURLToPath(import.meta.resolve("@alignfirst/docmap/invocation"))),
         join(process.cwd(), "node_modules/@alignfirst/docmap/dist/invocation.js"));
       for (const consumer of ["alignfirst", "aligndev"]) {
         const parent = pathToFileURL(join(process.cwd(), "node_modules", consumer, "package.json"));
         assert.equal(realpathSync(fileURLToPath(import.meta.resolve("@alignfirst/workspace", parent))),
           join(process.cwd(), "node_modules/@alignfirst/workspace/dist/index.js"));
       }`,
    ],
    { cwd: root, env: isolatedEnvironment(root), stdio: "inherit", timeout: 10000 },
  );
  const env = isolatedEnvironment(root);
  env.PATH = `${join(root, "node_modules/.bin")}${process.platform === "win32" ? ";" : ":"}${env.PATH}`;
  const project = join(root, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "--quiet"], { cwd: project, env });
  const report = JSON.parse(
    execFileSync(
      join(root, "node_modules/.bin/aligndev"),
      ["project", "status", project, "--json"],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10000,
      },
    ),
  );
  assert.equal(report.path, project, "Packed AlignDev must load the real AlignFirst config report");
  assert.equal(report.companion, null);
  assert.equal(report.locations.docs.path, join(project, "docs"));
  assert.equal(report.locations.alignfirst.path, join(project, "alignfirst.json"));
  assert.equal(report.portRange, null);
  const config = JSON.parse(
    execFileSync(join(root, "node_modules/.bin/alignfirst"), ["config", "--json"], {
      cwd: project,
      env,
      encoding: "utf8",
    }),
  );
  assert.equal(config.workspace.location.path, join(project, "alignfirst.json"));
  assert.equal(config.workspace.hasDevServer, false);
  assert.equal(Object.hasOwn(config, "cli"), false);
}

function packWorkspace(directory) {
  const packageRoot = join(repositoryRoot, "packages", directory);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const output = runNpm(["pack", "--json", "--pack-destination", installRoot], packageRoot);
  const filename = readPackedFilename(JSON.parse(output));
  if (typeof manifest.version !== "string" || typeof filename !== "string") {
    throw new Error(`Could not pack packages/${directory}.`);
  }
  const packed = {
    tarball: join(installRoot, filename),
    version: manifest.version,
    name: manifest.name,
  };
  if (process.env.PACKAGED_WORKSPACE_EVIDENCE !== undefined)
    appendFileSync(
      process.env.PACKAGED_WORKSPACE_EVIDENCE,
      `${JSON.stringify({
        kind: "localTarball",
        ...packed,
        sha256: createHash("sha256").update(readFileSync(packed.tarball)).digest("hex"),
        executable: process.execPath,
        node: process.version,
      })}\n`,
    );
  return packed;
}

function disposableInstall(name, packages, host = false) {
  const root = join(installRoot, name);
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}\n');
  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--omit=peer",
      "--no-audit",
      "--no-fund",
      ...packages.map((p) => p.tarball),
      ...(host ? ["@earendil-works/pi-coding-agent@1.4.0"] : []),
    ],
    root,
  );
  return root;
}

function installedManifest(root, name) {
  return JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
}

function verifyCliVersion(root, name, args, expected) {
  const executable = join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
  const actual = execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env: isolatedEnvironment(root),
  }).trim();
  assert.equal(actual, expected, `${name} ${args.join(" ")}`);
}

function isolatedEnvironment(root) {
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "home/.pi/agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  for (const key of Object.keys(env)) {
    if (
      /API_KEY|TOKEN|SECRET|PASSWORD/.test(key) ||
      ["NODE_PATH", "NODE_OPTIONS", "PI_PACKAGE_DIR", "PI_MANAGED_INSTALL_ROOT"].includes(key) ||
      /^(npm_|NPM_|BUN_|INIT_CWD$)/.test(key)
    )
      delete env[key];
  }
  return env;
}

function runNpm(args, cwd = installRoot) {
  return execFileSync("npm", args, { cwd, encoding: "utf8" });
}
