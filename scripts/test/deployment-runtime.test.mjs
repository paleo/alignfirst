import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderPiLauncher } from "../../skills/alignfirst-setup-guide/assets/aligndev-openclaw-template/base/infra/openclaw/node-runtime/pi-launcher.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const runtime = join(
  repository,
  "skills/alignfirst-setup-guide/assets/aligndev-openclaw-template/base/infra/openclaw/node-runtime",
);
const host = join(repository, "node_modules/@earendil-works/pi-coding-agent");
const guard = join(repository, "scripts/test/fixtures/deployment-deny-network.mjs");

// /usr/bin/node is absent on some developer machines. Only fixture launchers substitute this
// executable; production always uses the absolute system path and fails if it is unavailable.
test("launcher verifies the installed pin and declared bin, and preserves cwd/env/PATH/arguments", () => {
  withFixture((fixture) => {
    const root = fakePackage(fixture);
    const output = join(fixture.root, "record.json");
    writeFileSync(
      join(root, "dist/bundle/cli.js"),
      `import {writeFileSync} from "node:fs";
writeFileSync(process.env.RECORD, JSON.stringify({
  pid:process.pid, execPath:process.execPath, args:process.argv.slice(2),
  cwd:process.cwd(), path:process.env.PATH, value:process.env.KEEP_ME,
}));\n`,
    );
    const launcher = installFixtureLauncher(fixture, root);
    const args = ["", "two words", "--flag", "$(not-evaluated)", "'\"", "日本語"];
    const result = spawnSync(launcher, args, {
      ...options(fixture),
      env: { ...fixture.env, RECORD: output, KEEP_ME: "unchanged" },
    });
    assert.equal(result.status, 0, result.stderr?.toString());
    const record = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(record.args, args);
    assert.equal(record.pid, result.pid, "exec preserves process ownership");
    assert.equal(record.execPath, realpathSync(process.execPath));
    assert.equal(record.cwd, fixture.project);
    assert.equal(record.path, fixture.env.PATH);
    assert.equal(record.value, "unchanged");
    assert.match(readFileSync(launcher, "utf8"), /^#!\/bin\/sh\nexec /u);
  });
});

for (const [label, mutate] of [
  [
    "wrong version",
    (value) => {
      value.version = "1.3.1";
    },
  ],
  [
    "wrong package",
    (value) => {
      value.name = "other-package";
    },
  ],
  [
    "missing bin",
    (value) => {
      delete value.bin;
    },
  ],
  [
    "absolute bin",
    (value) => {
      value.bin.pi = "/tmp/cli.js";
    },
  ],
  [
    "escaping bin",
    (value) => {
      value.bin.pi = "../../cli.js";
    },
  ],
  [
    "missing entry",
    (value) => {
      value.bin.pi = "missing.js";
    },
  ],
  [
    "unknown engine range",
    (value) => {
      value.engines.node = "^22 || ^24";
    },
  ],
]) {
  test(`launcher refuses ${label} before installation`, () => {
    withFixture((fixture) => {
      const root = fakePackage(fixture);
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      mutate(manifest);
      writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
      assert.throws(() => renderPiLauncher(root, "1.3.0", "26.0.0"));
    });
  });
}

test("production generator refuses unprotected or out-of-prefix packages without privileged calls", () => {
  withFixture((fixture) => {
    const root = fakePackage(fixture);
    chmodSync(fixture.root, 0o777);
    const result = spawnSync(
      process.execPath,
      [join(runtime, "pi-launcher.mjs"), root, "1.3.0", fixture.root],
      options(fixture),
    );
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /not root-owned\/protected/u);
    const outside = spawnSync(
      process.execPath,
      [join(runtime, "pi-launcher.mjs"), host, "1.3.0", fixture.root],
      options(fixture),
    );
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /inside the protected prefix/u);
  });
});

test("launcher checks both Pi and extension Node floors, including a newer package requirement", () => {
  withFixture((fixture) => {
    const root = fakePackage(fixture);
    for (const version of ["20.19.0", "22.18.9", "22.19.0-rc.1"])
      assert.throws(() => renderPiLauncher(root, "1.3.0", version));
    for (const version of ["22.19.0", "24.0.0", "26.0.0"])
      assert.match(renderPiLauncher(root, "1.3.0", version), /exec \/usr\/bin\/node /u);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    manifest.engines.node = ">=26.1.0";
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    assert.throws(() => renderPiLauncher(root, "1.3.0", "26.0.0"), /unsupported/u);
    assert.doesNotThrow(() => renderPiLauncher(root, "1.3.0", "26.1.0"));
    assert.throws(() => renderPiLauncher(root, "latest"), /exact reviewed/u);
  });
});

test("launcher rejects symlinked source/entry paths and follows a changed declared bin on regeneration", () => {
  withFixture((fixture) => {
    const root = fakePackage(fixture);
    const link = join(fixture.root, "package-link");
    symlinkSync(root, link);
    assert.throws(() => renderPiLauncher(link, "1.3.0"), /Symlinked/u);
    rmSync(join(root, "dist/bundle/cli.js"));
    symlinkSync(join(root, "package.json"), join(root, "dist/bundle/cli.js"));
    assert.throws(() => renderPiLauncher(root, "1.3.0"), /Symlinked/u);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    manifest.bin.pi = "next cli.js";
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(root, "next cli.js"), "");
    assert.match(renderPiLauncher(root, "1.3.0"), /next cli\.js/u);
  });
});

for (const agent of ["claude", "codex", "pi"]) {
  test(`runtime checker preserves ${agent} command precedence against writable runtime shadows`, () => {
    withFixture((fixture) => {
      const home = join(fixture.root, "service");
      const opt = join(fixture.root, "opt");
      const audited = join(opt, "bin");
      const protectedBin = join(home, ".npm-system-global/bin");
      const runtimeBin = join(fixture.root, "runtime/bin");
      for (const path of [audited, protectedBin, runtimeBin]) mkdirSync(path, { recursive: true });
      for (const name of ["node", "npm"]) script(join(runtimeBin, name), "exit 0");
      script(join(audited, "openclaw"), "exit 0");
      script(join(protectedBin, "aligndev"), "exit 0");
      script(join(agent === "pi" ? audited : protectedBin, agent), "exit 0");
      const shell = join(fixture.root, "project-shell");
      script(
        shell,
        `export PATH=${quote(`${audited}:${protectedBin}:${runtimeBin}:/usr/bin:/bin`)}\nexport FNM_MULTISHELL_PATH=${quote(dirname(runtimeBin))}\nexec /bin/bash "$@"`,
      );
      const checker = renderChecker(home, opt).replace(
        /main "\$@"\s*$/u,
        "validate_environment && prepare_fixtures && trap cleanup EXIT && check_command_precedence",
      );
      const file = join(fixture.root, "checker.sh");
      writeFileSync(file, checker);
      run(fixture, "/bin/bash", [file], {
        CODING_AGENT: agent,
        PROJECT_SHELL: shell,
        DEFAULT_NODE: "26.0.0",
        PINNED_NODE: "24.0.0",
      });
      for (const name of ["openclaw", "aligndev", agent])
        assert.equal(
          existsSync(join(runtimeBin, name)),
          false,
          "Cleanup removes only fixture shadows",
        );
    });
  });
}

for (const directory of [".pi/agent", "native/custom agent"]) {
  test(`real offline Pi/${directory} and its bash tool retain launcher/project runtimes`, () => {
    withFixture((fixture) => {
      fixture.env.PI_CODING_AGENT_DIR = join(fixture.home, directory);
      nativeFixture(fixture);
      const launcher = installFixtureLauncher(fixture, host);
      run(fixture, launcher, [
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--model",
        "packed-fixture/local",
        "probe",
      ]);
      verifyNativeRecords(fixture);
    });
  });
}

test("rendered Pi checker probe executes offline with no model request", () => {
  withFixture((fixture) => {
    nativeFixture(fixture);
    const launcher = installFixtureLauncher(fixture, host);
    const shell = join(fixture.root, "project-shell");
    script(shell, 'exec /bin/bash "$@"');
    symlinkSync(launcher, join(fixture.projectBin, "pi"));
    const checker = renderChecker(fixture.home, fixture.root).replace(
      /main "\$@"\s*$/u,
      "validate_environment && prepare_fixtures && trap cleanup EXIT && check_pi_runtime",
    );
    const file = join(fixture.root, "checker.sh");
    writeFileSync(file, checker);
    run(fixture, "/bin/bash", [file], {
      CODING_AGENT: "pi",
      PROJECT_SHELL: shell,
      DEFAULT_NODE: "26.0.0",
      PINNED_NODE: "24.0.0",
    });
    assert.equal(
      existsSync(fixture.env.TOOL_RECORD),
      false,
      "The provider fixture was never called",
    );
  });
});

test("offline packed root subagent uses process.execPath instead of project PATH's node", () => {
  withFixture((fixture) => {
    nativeFixture(fixture);
    const packed = packSubagent(fixture);
    const driverRoot = fakePackage(fixture);
    writeFileSync(
      join(driverRoot, "dist/bundle/cli.js"),
      `import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";
import subagent from ${JSON.stringify(pathToFileURL(join(packed, "index.js")).href)};
let tool;
subagent({on() {}, registerTool(value) { assert.equal(tool, undefined); tool = value; }});
assert.equal(tool.name, "subagent");
const result = await tool.execute("runtime-probe", {task:"probe"}, undefined, undefined, {
  cwd:process.cwd(), model:{provider:"packed-fixture", id:"local"},
  thinkingLevel:"off", isProjectTrusted:()=>false,
});
assert.equal(result.isError, false, JSON.stringify(result));
assert.equal(result.structuredContent.results[0].output, "PACKED-CHILD-OK");
writeFileSync(process.env.PARENT_RECORD, JSON.stringify({runtime:process.execPath}));\n`,
    );
    const launcher = installFixtureLauncher(fixture, driverRoot);
    run(fixture, launcher, [], {
      PI_PACKAGE_DIR: host,
      PARENT_RECORD: join(fixture.root, "parent.json"),
    });
    const parent = JSON.parse(readFileSync(join(fixture.root, "parent.json"), "utf8"));
    const child = JSON.parse(readFileSync(join(fixture.root, "native.json"), "utf8"));
    assert.equal(
      child.runtime,
      parent.runtime,
      "Packaged production resolver reuses parent execPath",
    );
    assert.notEqual(child.runtime, join(fixture.projectBin, "node"));
    verifyNativeRecords(fixture);
  });
});

test("installer and checker syntax is valid without running privileged installation", () => {
  for (const name of ["install-pi-launcher.sh", "check-project-runtimes.sh"])
    execFileSync("/bin/bash", ["-n", join(runtime, name)]);
  execFileSync(process.execPath, ["--check", join(runtime, "pi-launcher.mjs")]);
  const installer = readFileSync(join(runtime, "install-pi-launcher.sh"), "utf8");
  assert.match(installer, /install -o root -g root -m 755/u);
  assert.match(
    installer,
    /\/usr\/bin\/node \/opt\/\{\{SERVICE_USER\}\}\/libexec\/pi-launcher\.mjs/u,
  );
  assert(!installer.includes("fnm"));
});

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "side25-b8-runtime-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const projectBin = join(root, "project-bin");
  for (const path of [project, home, projectBin]) mkdirSync(path);
  const fixture = {
    root,
    project,
    home,
    projectBin,
    env: {
      HOME: home,
      PATH: `${projectBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: root,
      PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      NODE_OPTIONS: `--import=${guard}`,
    },
  };
  try {
    callback(fixture);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakePackage(fixture) {
  const root = join(fixture.root, "package with 'quote");
  mkdirSync(join(root, "dist/bundle"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.3.0",
      type: "module",
      bin: { pi: "dist/bundle/cli.js" },
      engines: { node: ">=22.19.0" },
    }),
  );
  writeFileSync(join(root, "dist/bundle/cli.js"), "");
  return root;
}

function installFixtureLauncher(fixture, packageRoot) {
  const text = renderPiLauncher(packageRoot, "1.3.0");
  assert.match(text, /^#!\/bin\/sh\nexec \/usr\/bin\/node /u);
  const file = join(fixture.root, "pi");
  writeFileSync(file, text.replace("/usr/bin/node", quote(process.execPath)), { mode: 0o755 });
  return file;
}

function script(file, body) {
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderChecker(home, opt) {
  return readFileSync(join(runtime, "check-project-runtimes.sh"), "utf8")
    .replaceAll("/home/{{SERVICE_USER}}", home)
    .replaceAll("/opt/{{SERVICE_USER}}", opt)
    .replaceAll("/usr/bin/node", process.execPath);
}

function options(fixture, env = {}) {
  return {
    cwd: fixture.project,
    env: { ...fixture.env, ...env },
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 256 * 1024,
  };
}

function run(fixture, command, args, env = {}) {
  const result = spawnSync(command, args, options(fixture, env));
  assert.equal(
    result.status,
    0,
    `${command}: ${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
}

function nativeFixture(fixture) {
  // A distinct executable path makes accidental use of PATH's node observable in process.execPath.
  copyFileSync(process.execPath, join(fixture.projectBin, "node"));
  chmodSync(join(fixture.projectBin, "node"), 0o755);
  const agentDir = fixture.env.PI_CODING_AGENT_DIR;
  mkdirSync(agentDir, { recursive: true });
  const provider = join(fixture.root, "provider.mjs");
  copyFileSync(join(repository, "scripts/pi-smoke-provider.mjs"), provider);
  const audit = join(fixture.root, "audit.mjs");
  writeFileSync(
    audit,
    `import {writeFileSync} from "node:fs";
export default function (pi) {
  pi.on("session_start", () => writeFileSync(process.env.NATIVE_RECORD, JSON.stringify({
    runtime:process.execPath, path:process.env.PATH, cwd:process.cwd(),
  })));
}\n`,
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [provider, audit],
      defaultProvider: "packed-fixture",
      defaultModel: "local",
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  const childScript = join(fixture.root, "tool-child.cjs");
  writeFileSync(
    childScript,
    `require("node:fs").writeFileSync(process.env.TOOL_RECORD, JSON.stringify({
    runtime:process.execPath, path:process.env.PATH, cwd:process.cwd(),
  }));\n`,
  );
  Object.assign(fixture.env, {
    NATIVE_RECORD: join(fixture.root, "native.json"),
    TOOL_RECORD: join(fixture.root, "tool.json"),
    PI_SMOKE_CHILD_COMMAND: `node ${quote(childScript)}`,
  });
}

function verifyNativeRecords(fixture) {
  const native = JSON.parse(readFileSync(join(fixture.root, "native.json"), "utf8"));
  const tool = JSON.parse(readFileSync(join(fixture.root, "tool.json"), "utf8"));
  assert.equal(native.runtime, realpathSync(process.execPath));
  assert.equal(tool.runtime, join(fixture.projectBin, "node"));
  assert.equal(native.path, fixture.env.PATH, "The launcher/native process preserves PATH exactly");
  assert.equal(
    tool.path,
    `${fixture.env.PI_CODING_AGENT_DIR}/bin:${fixture.env.PATH}`,
    "Pi's native shell helper prepends only its managed bin; project PATH remains intact",
  );
  for (const record of [native, tool]) assert.equal(record.cwd, fixture.project);
}

function packSubagent(fixture) {
  const npm = join(dirname(process.execPath), "npm");
  const output = execFileSync(
    npm,
    ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", fixture.root],
    {
      ...options(fixture),
      cwd: join(repository, "packages/pi-subagent"),
    },
  );
  const result = JSON.parse(output);
  const [packed] = Array.isArray(result) ? result : Object.values(result);
  const destination = join(fixture.root, "packed");
  mkdirSync(destination);
  execFileSync("tar", ["-xf", join(fixture.root, packed.filename), "-C", destination]);
  const root = join(destination, "package");
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  assert.equal(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pi.extensions[0],
    "./index.js",
  );
  return root;
}
