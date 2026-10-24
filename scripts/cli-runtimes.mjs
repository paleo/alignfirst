import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.CLI_RUNTIME_OUTPUT ?? mkdtempSync(join(tmpdir(), "side20-runtimes-"));
const consumer = join(output, "consumer");
const tools = join(output, "tools");
const bunSource = process.env.BUN_BIN;
const npm = join(dirname(process.execPath), "npm");
const packages = ["docmap", "alignfirst", "aligndev", "workspace", "openclaw-test"];
let ownsOutput = false;

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  console.log(`Runtime acceptance artifacts: ${output}`);
  if (ownsOutput && process.env.CLI_RUNTIME_KEEP !== "1") {
    for (const name of [
      "consumer",
      "tools",
      "home",
      "tmp",
      "consumer-runtime-child",
      "aligndev-owned-worktree",
      "native-project",
    ]) {
      rmSync(join(output, name), { recursive: true, force: true });
    }
  }
}

function main() {
  assert.ok(bunSource !== undefined && existsSync(bunSource), "BUN_BIN is required; no skip tier");
  assert.ok(output.startsWith("/tmp/"), "CLI_RUNTIME_OUTPUT must be an empty directory under /tmp");
  mkdirSync(output, { recursive: true });
  assert.equal(readdirSync(output).length, 0, "CLI_RUNTIME_OUTPUT must be empty");
  ownsOutput = true;
  mkdirSync(tools, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  mkdirSync(join(output, "home"), { recursive: true });
  mkdirSync(join(output, "tmp"), { recursive: true });
  copyFileSync(realpathSync(bunSource), join(tools, "bun"));
  symlinkSync("bun", join(tools, "bunx"));
  const env = cleanEnvironment();
  assert.equal(run("bun-version", join(tools, "bun"), ["--version"], env).trim(), "1.4.4");
  buildAndInstall(env);
  prepareFixtures();
  run("node-present", process.execPath, [join(consumer, "acceptance.mjs"), "matrix"], env);
  const restricted = { ...env, PATH: `${tools}:/usr/bin:/bin` };
  run(
    "restricted-path",
    join(tools, "bun"),
    [join(consumer, "acceptance.mjs"), "restricted"],
    restricted,
  );
  // Hide complete runtime installation roots, not just their PATH entries. /tmp contains only
  // our copied Bun and packed consumer; no host-runtime mount is added back.
  const mounts = ["/home", "/root", "/usr/local", "/opt", dirname(dirname(process.execPath))];
  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--tmpfs",
    "/tmp",
    "--bind",
    output,
    output,
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--unshare-net",
  ];
  for (const path of [...new Set(mounts)]) {
    if (existsSync(path)) args.push("--tmpfs", path);
  }
  for (const path of [
    "/usr/bin/node",
    "/usr/bin/npm",
    "/usr/bin/npx",
    "/bin/node",
    "/bin/npm",
    "/bin/npx",
  ]) {
    if (existsSync(path)) args.push("--ro-bind", "/dev/null", path);
  }
  const proof = `for name in node npm npx; do if command -v "$name"; then exit 90; fi; done; if '${process.execPath}' --version; then exit 91; fi; echo NODE_ABSENT_PROVED; exec '${join(tools, "bun")}' '${join(consumer, "acceptance.mjs")}' isolated`;
  run("node-absent", "bwrap", [...args, "/bin/sh", "-c", proof], restricted);
  console.log(
    "PASS packed Node/Bun matrix, restricted-PATH tier and filesystem-isolated acceptance",
  );
}

function cleanEnvironment() {
  return {
    PATH: `${dirname(process.execPath)}:${tools}:/usr/bin:/bin`,
    HOME: join(output, "home"),
    TMPDIR: join(output, "tmp"),
    LANG: "C.UTF-8",
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(output, "gitconfig"),
    ALIGNFIRST_ARCHIVE_THRESHOLD_DAYS: "99999",
    CLI_RUNTIME_OUTPUT: output,
    CLI_RUNTIME_NODE: process.execPath,
    CLI_RUNTIME_BUN: join(tools, "bun"),
  };
}

function buildAndInstall(env) {
  const buildArgs = [
    "run",
    "build",
    ...packages.flatMap((name) => ["--workspace", `./packages/${name}`]),
  ];
  run("build", npm, buildArgs, { ...env, HOME: process.env.HOME }, repository);
  const dependencies = { openclaw: "2026.10.5", "yarn-classic": "npm:yarn@1.22.22" };
  for (const name of packages) {
    const packed = run(
      `pack-${name}`,
      npm,
      ["pack", "--ignore-scripts", "--json", "--pack-destination", output],
      env,
      join(repository, "packages", name),
    );
    const record = JSON.parse(packed)[0];
    dependencies[record.name] = `file:${join(output, record.filename)}`;
  }
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "side20-packed-runtime-consumer",
        private: true,
        type: "module",
        dependencies,
        overrides: { "@alignfirst/docmap": "$@alignfirst/docmap" },
        scripts: {
          af: "alignfirst",
          "custom docs": "docmap",
          ad: "aligndev",
          "af$&": "alignfirst",
          "ad$&": "aligndev",
          "dm$&": "docmap",
          workspace: "bun workspace.mjs",
          dev: "bun dev.mjs",
        },
      },
      null,
      2,
    ),
  );
  run(
    "install",
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { ...env, HOME: process.env.HOME },
    consumer,
    600_000,
  );
  run("installed-graph", npm, ["ls", "--depth=0"], env, consumer);
  for (const name of packages) {
    const manifest = JSON.parse(readFileSync(join(repository, "packages", name, "package.json")));
    const installed = realpathSync(join(consumer, "node_modules", manifest.name));
    assert.ok(installed.startsWith(`${consumer}/`), `${manifest.name} escaped packed install`);
  }
}

function prepareFixtures() {
  copyFileSync(
    join(repository, "scripts/test/cli-runtime-native.mjs"),
    join(consumer, "native-agent.mjs"),
  );
  copyFileSync(
    join(repository, "scripts/test/cli-runtime-agent.mjs"),
    join(consumer, "fake-agent.mjs"),
  );
  copyFileSync(
    join(repository, "scripts/test/cli-runtime-acceptance.mjs"),
    join(consumer, "acceptance.mjs"),
  );
  copyFileSync(join(repository, "scripts/test/cli-runtime-audit.mjs"), join(consumer, "audit.mjs"));
  copyFileSync(
    join(repository, "packages/openclaw-test/test/fixtures/fake-docker.mjs"),
    join(consumer, "fake-docker.mjs"),
  );
  const helpers = readFileSync(
    join(repository, "packages/openclaw-test/test/fixtures/runtime-helpers.mjs"),
    "utf8",
  ).replaceAll("../../dist/", "./node_modules/@alignfirst/openclaw-test/dist/");
  writeFileSync(join(consumer, "runtime-helpers.mjs"), helpers);
  writeFileSync(
    join(output, "gitconfig"),
    "[user]\nname = Runtime Acceptance\nemail = acceptance@example.invalid\n[safe]\ndirectory = *\n",
  );
}

function run(label, command, args, env, cwd = consumer, timeout = 120_000) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  writeFileSync(
    join(output, `${label}.log`),
    `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `${label}: exit ${result.status}; see ${join(output, `${label}.log`)}`,
  );
  console.log(`PASS ${label}`);
  return result.stdout;
}
