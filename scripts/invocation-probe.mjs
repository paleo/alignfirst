import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const bunVersion = "1.4.4";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bun = process.env.BUN_BIN;
const directory = mkdtempSync(join(tmpdir(), "side20-invocation-"));

try {
  runProbe();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function runProbe() {
  const env = cleanEnvironment();
  const npm = join(dirname(process.execPath), "npm");
  const npx = join(dirname(process.execPath), "npx");
  prepareFixture();
  const cases = [
    ["direct-node", process.execPath, ["probe.mjs"], "node", "direct", "side20-invocation-probe"],
    [
      "npx",
      npx,
      ["--no-install", "side20-invocation-probe"],
      "node",
      "packageRunner",
      "npx -y side20-invocation-probe",
    ],
    [
      "npm-exec",
      npm,
      ["exec", "--no", "--", "side20-invocation-probe"],
      "node",
      "packageRunner",
      "npx -y side20-invocation-probe",
    ],
    [
      "npm-run",
      npm,
      ["run", "probe", "--", "arg with spaces"],
      "node",
      "projectScript",
      "npm run probe",
    ],
    [
      "npm-run-nested-same-target",
      npm,
      ["run", "probe", "--", "nested"],
      "node",
      "packageRunner",
      "npx -y side20-invocation-probe",
    ],
    [
      "npm-run-nested-wrapper",
      npm,
      ["run", "ancestor"],
      "node",
      "packageRunner",
      "npx -y side20-invocation-probe",
    ],
  ];
  if (bun === undefined) {
    console.log(
      "SKIP Bun launches: supply BUN_BIN pointing to npm-installed Bun 1.4.4 (required for acceptance)",
    );
  } else {
    assert.equal(run(bun, ["--version"], env).stdout.trim(), bunVersion);
    const bunx = join(dirname(bun), "bunx");
    const fullBunx = join(dirname(realpathSync(bun)), "bunx.exe");
    assert.ok(existsSync(bunx), "the actual .bin/bunx alias is required");
    assert.ok(existsSync(fullBunx), "npm-distributed bunx.exe is required");
    cases.push(
      ["direct-bun", bun, ["probe.mjs"], "bun", "direct", "bunx --bun side20-invocation-probe"],
      [
        "bunx-alias",
        bunx,
        ["side20-invocation-probe"],
        "node",
        "packageRunner",
        "bunx side20-invocation-probe",
      ],
      [
        "bun-x",
        bun,
        ["x", "side20-invocation-probe"],
        "node",
        "packageRunner",
        "bunx side20-invocation-probe",
      ],
      [
        "bunx-alias-forced",
        bunx,
        ["--bun", "side20-invocation-probe"],
        "bun",
        "packageRunner",
        "bunx --bun side20-invocation-probe",
      ],
      [
        "bun-x-forced",
        bun,
        ["x", "--bun", "side20-invocation-probe"],
        "bun",
        "packageRunner",
        "bunx --bun side20-invocation-probe",
      ],
      [
        "bunx-full-path",
        fullBunx,
        ["side20-invocation-probe"],
        "node",
        "packageRunner",
        "bunx side20-invocation-probe",
      ],
      [
        "bunx-full-path-forced",
        fullBunx,
        ["--bun", "side20-invocation-probe"],
        "bun",
        "packageRunner",
        "bunx --bun side20-invocation-probe",
      ],
      ["bun-run", bun, ["run", "probe"], "node", "projectScript", "bun run probe"],
      [
        "bun-run-forced",
        bun,
        ["--bun", "run", "probe"],
        "bun",
        "projectScript",
        "bun --bun run probe",
      ],
      [
        "bun-explicit-entry",
        bun,
        ["run", "bunEntry"],
        "bun",
        "projectScript",
        "bun --bun run bunEntry",
      ],
      [
        "bun-forced-node-entry",
        bun,
        ["--bun", "run", "nodeEntry"],
        "bun",
        "projectScript",
        "bun --bun run nodeEntry",
      ],
      [
        "npm-bun-entry",
        npm,
        ["run", "bunEntry"],
        "bun",
        "projectScript",
        "bunx --bun side20-invocation-probe",
      ],
      [
        "bun-run-nested-same-target",
        bun,
        ["run", "probe", "nested"],
        "node",
        "packageRunner",
        "bunx side20-invocation-probe",
      ],
      [
        "bun-run-forced-nested-same-target",
        bun,
        ["--bun", "run", "probe", "nested"],
        "bun",
        "packageRunner",
        "bunx --bun side20-invocation-probe",
      ],
    );
  }
  for (const [name, executable, args, runtime, launcher, prefix] of cases) {
    const child = run(executable, args, env);
    const line = child.stdout.split("\n").findLast((line) => line.startsWith("{"));
    assert.ok(line, `${name}: missing result: ${child.stdout}`);
    const record = JSON.parse(line);
    console.log(JSON.stringify({ name, ...record }));
    assert.equal(record.runtime, runtime, name);
    assert.equal(record.launcher, launcher, name);
    assert.equal(record.self.base, prefix, name);
    if (runtime === "bun")
      assert.equal(record.counterpart.base, "bunx --bun @alignfirst/docmap", name);
    if (name === "bunx-full-path-forced") {
      // npm-distributed Bun can use bunx.exe as execPath. Re-exec that exact path, without a basename gate.
      const again = run(record.executable, [join(directory, "probe.mjs")], env);
      const result = JSON.parse(again.stdout.trim());
      assert.equal(result.runtime, "bun");
    }
  }
  let additional = 0;
  if (bun !== undefined) {
    const restricted = join(directory, "bun-only");
    mkdirSync(restricted);
    symlinkSync(realpathSync(bun), join(restricted, "bun"));
    symlinkSync(realpathSync(join(dirname(bun), "bunx")), join(restricted, "bunx"));
    for (const args of [["side20-invocation-probe"], ["--bun", "side20-invocation-probe"]]) {
      const child = run(join(restricted, "bunx"), args, { ...env, PATH: restricted });
      const record = JSON.parse(child.stdout.trim());
      console.log(JSON.stringify({ name: `node-absent-${args.length}`, ...record }));
      assert.equal(record.runtime, "bun");
      assert.equal(record.self.base, "bunx --bun side20-invocation-probe");
      const followup = run(record.self.executable, [...record.self.args, "child"], {
        ...env,
        PATH: restricted,
      });
      assert.equal(JSON.parse(followup.stdout.trim()).runtime, "bun");
      ++additional;
    }
  }
  console.log(
    `PASS ${cases.length + additional} real launches; Node ${process.versions.node}; Bun ${bun === undefined ? "skipped" : bunVersion}`,
  );
}

function cleanEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("npm_") && !["NODE", "NODE_OPTIONS", "INIT_CWD", "BUN_BIN"].includes(key),
    ),
  );
  // Each cell starts from this baseline; never reuse the PATH injected by a forced-Bun child.
  env.PATH = [
    dirname(process.execPath),
    ...(bun === undefined ? [] : [dirname(bun)]),
    "/usr/bin",
    "/bin",
  ].join(":");
  return env;
}

function prepareFixture() {
  const helper = pathToFileURL(join(root, "packages/docmap/dist/invocation.js")).href;
  assert.ok(existsSync(fileURLToPath(helper)), "build @alignfirst/docmap first");
  const source = readFileSync(join(root, "scripts/test/invocation-fixture.mjs"), "utf8");
  writeFileSync(join(directory, "probe.mjs"), source.replace("__INVOCATION_URL__", helper));
  chmodSync(join(directory, "probe.mjs"), 0o755);
  mkdirSync(join(directory, "node_modules", ".bin"), { recursive: true });
  symlinkSync(
    join(directory, "probe.mjs"),
    join(directory, "node_modules", ".bin", "side20-invocation-probe"),
  );
  writeFileSync(
    join(directory, "ancestor.mjs"),
    'import { spawnSync } from "node:child_process"; const c = spawnSync(process.execPath, ["probe.mjs"], { stdio: "inherit" }); process.exit(c.status ?? 1);\n',
  );
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "side20-invocation-consumer",
      version: "1.0.0",
      type: "module",
      scripts: {
        probe: "side20-invocation-probe",
        ancestor: "node ancestor.mjs",
        bunEntry: "bun probe.mjs",
        nodeEntry: "node probe.mjs",
      },
    }),
  );
}

function run(executable, args, env) {
  const child = spawnSync(executable, args, {
    cwd: directory,
    env: { ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(child.error, undefined, `${executable}: ${child.error?.message}`);
  assert.equal(child.status, 0, `${executable} ${args.join(" ")}: ${child.stderr}`);
  return child;
}
