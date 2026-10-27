import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const root = import.meta.dirname;
const output = process.env.CLI_RUNTIME_OUTPUT;
const bun = process.env.CLI_RUNTIME_BUN;
const node = process.env.CLI_RUNTIME_NODE;
const tier = process.argv[2];
const audit = join(output, `${tier}-runtime.jsonl`);
const commands = join(output, `${tier}-commands.jsonl`);
const bin = join(root, "node_modules/.bin");
const entries = {
  alignfirst: join(bin, "alignfirst"),
  aligndev: join(bin, "aligndev"),
  docmap: join(bin, "docmap"),
  "openclaw-test": join(bin, "openclaw-test"),
};
const baseEnvironment = {
  ...process.env,
  PATH: `${dirname(bun)}:${tier === "matrix" ? `${dirname(node)}:` : ""}/usr/bin:/bin`,
  NODE_OPTIONS: `--require=${join(root, "audit.mjs")}`,
  BUN_OPTIONS: `--preload=${join(root, "audit.mjs")}`,
  CLI_RUNTIME_AUDIT: audit,
  CLI_RUNTIME_PROMPT: join(root, "delegated-prompt.txt"),
  CLI_RUNTIME_AGENT_PID: join(root, "agent.pid"),
};

await main();

async function main() {
  writeFileSync(audit, "");
  writeFileSync(commands, "");
  if (tier === "matrix") return matrix();
  if (tier === "restricted") {
    check("PATH excludes Node", "/bin/sh", [
      "-c",
      "! command -v node && ! command -v npm && ! command -v npx",
    ]);
    check("restricted Bun context", "bunx", ["--bun", "alignfirst", "context"], {
      runtime: "bun",
      contains: "bunx --bun alignfirst",
    });
    return;
  }
  assert.equal(tier, "isolated");
  prepareProject();
  alignfirstLifecycle();
  await alignDevLifecycle();
  companionAndCustomRoots();
  await workspaceLifecycle();
  await harnessLifecycle();
  const records = readRecords(audit);
  assert.ok(records.some((record) => record.argv.some((arg) => arg.includes("alignfirst"))));
  assert.ok(
    records.every((record) => record.runtime === "bun"),
    "isolated JS process used real Node",
  );
  console.log(`PASS isolated lifecycle; ${records.length} observed Bun processes`);
}

function matrix() {
  const npm = join(dirname(node), "npm");
  const npx = join(dirname(node), "npx");
  const cells = [
    ["npx", npx, ["alignfirst"], "node", "npx -y alignfirst"],
    ["npx-y", npx, ["-y", "alignfirst"], "node", "npx -y alignfirst"],
    ["npm-exec", npm, ["exec", "--", "alignfirst"], "node", "npx -y alignfirst"],
    ["bunx", "bunx", ["alignfirst"], "node", "bunx alignfirst"],
    ["bun-x", bun, ["x", "alignfirst"], "node", "bunx alignfirst"],
    ["bunx-forced", "bunx", ["--bun", "alignfirst"], "bun", "bunx --bun alignfirst"],
    ["bun-x-forced", bun, ["x", "--bun", "alignfirst"], "bun", "bunx --bun alignfirst"],
    ["direct-executable", entries.alignfirst, [], "node", "alignfirst"],
    ["direct-node", node, [entries.alignfirst], "node", "alignfirst"],
    ["direct-bun", bun, [entries.alignfirst], "bun", "bunx --bun alignfirst"],
    ["npm-custom-script", npm, ["run", "af", "--"], "node", "npm run af --"],
    ["bun-script", bun, ["run", "af"], "node", "bun run af"],
    ["bun-forced-script", bun, ["--bun", "run", "af"], "bun", "bun --bun run af"],
  ];
  // The backticks anchor the whole emitted command: "bun run af" also occurs in "bun --bun run af".
  for (const [name, executable, prefix, runtime, command] of cells) {
    check(name, executable, [...prefix, "context"], {
      runtime,
      contains: `\`${command} guide <protocol>\``,
    });
  }
  for (const [name, entry] of Object.entries(entries)) {
    for (const runtime of ["node", "bun"]) {
      check(`${name}-${runtime}-help`, runtime === "node" ? node : bun, [entry, "--help"], {
        runtime,
        status: name === "openclaw-test" ? 1 : 0,
      });
    }
  }
  packageRunnerMatrix(npm, npx);
  scriptAndLockMatrix(npm, npx);
  literalScriptMatrix(npm);
  externalNativeMatrix(npm);
  workspaceLifecycle(node, "node");
  workspaceLifecycle(bun, "bun");
  console.log(
    "PASS real launch matrix, verified scripts, conflicting locks and packed package help",
  );
}

function packageRunnerMatrix(npm, npx) {
  for (const [name, packageName] of [
    ["aligndev", "aligndev"],
    ["docmap", "@alignfirst/docmap"],
    ["openclaw-test", "@alignfirst/openclaw-test"],
  ]) {
    const runners = [
      ["npx", npx, [packageName], "node", `npx -y ${packageName}`],
      ["npx-y", npx, ["-y", packageName], "node", `npx -y ${packageName}`],
      ["npm-exec", npm, ["exec", "--", packageName], "node", `npx -y ${packageName}`],
      ["bunx", "bunx", [packageName], "node", `bunx ${packageName}`],
      ["bun-x", bun, ["x", packageName], "node", `bunx ${packageName}`],
      ["bunx-forced", "bunx", ["--bun", packageName], "bun", `bunx --bun ${packageName}`],
      ["bun-x-forced", bun, ["x", "--bun", packageName], "bun", `bunx --bun ${packageName}`],
    ];
    for (const [runner, executable, args, runtime, contains] of runners) {
      check(`${name}-${runner}`, executable, [...args, "--help"], {
        runtime,
        contains,
        status: name === "openclaw-test" ? 1 : 0,
      });
    }
  }
}

function scriptAndLockMatrix(npm, npx) {
  check("custom-npm-docmap-script", npm, ["run", "custom docs", "--", "--help"], {
    runtime: "node",
    contains: "npm run 'custom docs' --",
  });
  check("custom-forced-bun-docmap-script", bun, ["--bun", "run", "custom docs", "--help"], {
    runtime: "bun",
    contains: "bun --bun run 'custom docs'",
  });
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  delete manifest.scripts["custom docs"];
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest, null, 2));
  for (const lock of ["pnpm-lock.yaml", "yarn.lock", "bun.lock"])
    writeFileSync(join(root, lock), "");
  check("standalone-runner-beats-locks", "bunx", ["--bun", "@alignfirst/docmap", "--help"], {
    runtime: "bun",
    contains: "bunx --bun @alignfirst/docmap",
  });
  check("npm-runner-beats-locks-without-script", npx, ["-y", "@alignfirst/docmap", "--help"], {
    runtime: "node",
    contains: "npx -y @alignfirst/docmap",
  });
}

function literalScriptMatrix(npm) {
  const context = check("dollar-script-context", npm, ["run", "af$&", "--", "context"], {
    runtime: "node",
    contains: "npm run 'af$&' -- guide <protocol>",
  });
  const emitted = context.match(/`(npm run 'af\$&' -- guide <protocol>)`/)[1];
  shell(
    "dollar-script-emitted-guide",
    `${emitted.replace("<protocol>", "spec")} --protocol-only`,
    "node",
  );
  check("dollar-docmap-guide", npm, ["run", "dm$&", "--", "--guide"], {
    runtime: "node",
    contains: "npm run 'dm$&' -- --check",
  });
}

function externalNativeMatrix(npm) {
  const project = join(output, "native-project");
  const nativeBin = join(project, "native-bin");
  const log = join(output, "native-processes.jsonl");
  const settings = join(process.env.HOME, ".alignfirst", "aligndev.settings.json");
  mkdirSync(nativeBin, { recursive: true });
  mkdirSync(join(project, ".plans"));
  writeFileSync(join(project, ".gitignore"), ".plans/\nnode_modules/\n");
  mkdirSync(dirname(settings), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(project, "node_modules"));
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { ad: "aligndev", "ad$&": "aligndev" },
    }),
  );
  check("native-git-init", "git", ["init", "-b", "main"], { cwd: project });
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(nativeBin, name), readFileSync(join(root, "native-agent.mjs")), {
      mode: 0o755,
    });
  }
  const explicitBin = join(project, "explicit-bun");
  mkdirSync(explicitBin);
  symlinkSync(bun, join(explicitBin, "node"));
  writeFileSync(
    settings,
    JSON.stringify({
      platform: "codingAgent",
      code: {
        profile: "claude",
        profiles: {
          claude: { agent: "claude", defaultModel: "haiku" },
          codex: { agent: "codex", defaultModel: "sol" },
          explicitQuota: { agent: "claude", quota: { source: "codex" } },
          explicitBun: {
            agent: "claude",
            defaultModel: "haiku",
            env: { PATH: `${explicitBin}:${nativeBin}:${baseEnvironment.PATH}` },
          },
        },
      },
    }),
  );
  const env = { PATH: `${nativeBin}:${bin}:${baseEnvironment.PATH}`, CLI_NATIVE_LOG: log };
  const launchers = [
    ["node", node, [entries.aligndev], "node"],
    ["bun-direct", bun, [entries.aligndev], "bun"],
    ["bunx-forced", "bunx", ["--bun", "aligndev"], "bun"],
    ["bun-script-forced", bun, ["--bun", "run", "ad"], "bun"],
  ];
  for (const [name, executable, prefix, runtime] of launchers) {
    const invoke = (suffix, args) =>
      check(`native-${name}-${suffix}`, executable, [...prefix, ...args], {
        cwd: project,
        env,
        runtime,
      });
    invoke("agent", ["code", "new", "-m", "Offline native fixture", "--quiet"]);
    invoke("implicit-claude-quota", ["code", "quota"]);
    invoke("discovery-agent", ["code", "new", "--profile", "codex", "-m", "Discover", "--quiet"]);
    invoke("implicit-codex-quota", ["code", "quota", "--profile", "codex"]);
    invoke("explicit-quota", ["code", "quota", "--profile", "explicitQuota"]);
  }
  assert.ok(readRecords(log).length >= launchers.length * 6);
  assert.ok(readRecords(log).every((record) => record.runtime === "node"));
  const before = readRecords(log).length;
  check(
    "native-explicit-bun-PATH",
    bun,
    [
      "--bun",
      "run",
      "ad",
      "code",
      "new",
      "--profile",
      "explicitBun",
      "-m",
      "Deliberate Bun",
      "--quiet",
    ],
    {
      cwd: project,
      runtime: "bun",
      env: { ...env, CLI_NATIVE_EXPECT: "bun" },
    },
  );
  assert.equal(readRecords(log)[before].runtime, "bun");
  const yarn = join(root, "node_modules", "yarn-classic", "bin", "yarn.js");
  check("yarn-classic-counterpart", node, [yarn, "run", "ad", "code", "quota"], {
    cwd: project,
    env,
    runtime: "node",
    contains: "25% used",
  });
  const guide = check("dollar-aligndev-guide", npm, ["run", "ad$&", "--", "guide", "code"], {
    cwd: project,
    env,
    runtime: "node",
    contains: "npm run 'ad$&' -- code status",
  });
  assert.ok(!guide.includes("{{"));
  check(
    "dollar-aligndev-followup",
    "/bin/sh",
    ["-c", "npm run 'ad$&' -- code status --no-ticket"],
    {
      cwd: project,
      env,
      runtime: "node",
    },
  );
  const owned = readRecords(commands).find(
    (record) => record.label === "native-bunx-forced-agent",
  ).observed;
  const counterparts = owned.filter((record) => record.argv[0]?.endsWith("/alignfirst"));
  assert.ok(counterparts.length > 0);
  for (const record of counterparts) {
    assert.equal(record.runtime, "bun");
    assert.deepEqual(record.parentArgv.slice(0, 3), ["bunx", "--bun", "alignfirst"]);
  }
}

function prepareProject() {
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, ".plans"), { recursive: true });
  writeFileSync(
    join(root, "docs", "runtime.md"),
    "---\ntitle: Runtime Acceptance\nsummary: Offline runtime fixture.\n---\n\n# Runtime Acceptance\n\nPacked fixture content.\n",
  );
  writeFileSync(
    join(root, ".gitignore"),
    "node_modules/\n.plans/\n.local-wt/\nartifacts/\n.workers/\nowned-worktree/\n*.jsonl\n",
  );
  check("git-init", "git", ["init", "-b", "main"]);
  check("git-add", "git", ["add", "."]);
  check("git-commit", "git", ["commit", "-m", "runtime fixture"]);
}

function alignfirstLifecycle() {
  const context = af("context", ["context"]);
  assert.ok(context.includes("bunx --bun alignfirst guide"));
  const emitted = context.match(/`(bunx --bun alignfirst guide <protocol>)`/)[1];
  shell("emitted-context-guide", `${emitted.replace("<protocol>", "spec")} --protocol-only`, "bun");
  af("full-guide", ["guide", "plan"]);
  af("config", ["config", "--json"]);
  af("plans-check", ["plans", "check"]);
  af("ticket-open", ["ticket", "side-1", "--json"]);
  writeFileSync(
    join(root, ".plans/side-1/B1-request.md"),
    "# Request\n\nOffline packed acceptance.\n",
  );
  af("ticket-catchup", ["ticket", "side-1", "--catchup"]);
  af("ticket-reservation", ["ticket", "--side", "--json"]);
  af("sync", ["sync"]);
  writeFileSync(join(root, "alignfirst.json"), JSON.stringify({ schemaVersion: 1 }));
  const report = JSON.parse(af("new-config-report", ["config", "--json"]));
  assert.equal(report.locations.alignfirst.path, join(root, "alignfirst.json"));
  assert.equal(report.workspace.location.path, join(root, "alignfirst.json"));
  assert.equal(Object.hasOwn(report, "cli"), false);
  for (const args of [[], ["runtime.md"], ["--search", "runtime"], ["--check"], ["--guide"]]) {
    af(`embedded-docmap-${args.join("-")}`, ["docmap", ...args]);
  }
  const docmap = check(
    "standalone-docmap-guide",
    "bunx",
    ["--bun", "@alignfirst/docmap", "--guide"],
    { runtime: "bun", contains: "bunx --bun @alignfirst/docmap" },
  );
  assert.ok(docmap.includes("--check"));
  shell(
    "emitted-docmap-check",
    exampleCommand(docmap, "bunx --bun @alignfirst/docmap --check"),
    "bun",
  );
  check("isolated-ordinary-bunx-fallback", "bunx", ["alignfirst", "context"], {
    runtime: "bun",
    contains: "bunx --bun alignfirst",
  });
  check("isolated-direct-bun", bun, [entries.alignfirst, "context"], {
    runtime: "bun",
    contains: "bunx --bun alignfirst",
  });
}

function af(label, args, options = {}) {
  return check(label, "bunx", ["--bun", "alignfirst", ...args], { runtime: "bun", ...options });
}

function shell(label, command, runtime) {
  return check(label, "/bin/sh", ["-c", command], { runtime });
}

async function alignDevLifecycle() {
  const home = process.env.HOME;
  mkdirSync(join(home, ".alignfirst"), { recursive: true });
  writeFileSync(
    join(home, ".alignfirst/aligndev.settings.json"),
    JSON.stringify({
      code: {
        profile: "offline",
        profiles: { offline: { agent: "claude", defaultModel: "haiku" } },
      },
    }),
  );
  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "claude"),
    `#!/bin/sh\nexec '${bun}' '${join(root, "fake-agent.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  const env = { PATH: `${fakeBin}:${baseEnvironment.PATH}` };
  const ad = (label, args, options = {}) =>
    check(label, "bunx", ["--bun", "aligndev", ...args], { runtime: "bun", env, ...options });
  ad("aligndev-guide", ["guide", "code"], { contains: "bunx --bun alignfirst" });
  ad("project-diagnostic", ["project", "list", "--json"], {
    status: 1,
    contains: "bunx --bun aligndev project init",
  });
  shell("emitted-project-init", "bunx --bun aligndev project init", "bun");
  ad("project-list", ["project", "list", "--json"]);
  af("unified-workspace-list", ["workspace", "list", "--json"]);
  const worktree = join(dirname(root), "aligndev-owned-worktree");
  af("unified-workspace-add", [
    "workspace",
    "setup",
    "-c",
    "side-2/runtime",
    "--path",
    worktree,
    "--json",
  ]);
  af("unified-workspace-remove", ["workspace", "remove", worktree, "--json"]);
  ad("delegation", [
    "code",
    "new",
    "--protocol",
    "spec",
    "--catchup",
    "--ticket",
    "side-1",
    "-m",
    "Offline fixture",
    "--quiet",
  ]);
  const prompt = readFileSync(join(root, "delegated-prompt.txt"), "utf8");
  assert.ok(prompt.includes("bunx --bun alignfirst guide spec"));
  assert.ok(prompt.includes("Offline packed acceptance"));
  shell("emitted-delegated-guide", "bunx --bun alignfirst guide spec --protocol-only", "bun");
  ad("delegation-status", ["code", "status", "--ticket", "side-1", "--result"], {
    contains: "offline complete",
  });
  ad("delegation-resume", [
    "code",
    "resume",
    "offline-session",
    "-m",
    "Continue offline",
    "--quiet",
  ]);
  ad("delegation-failure", ["code", "new", "-m", "Fail offline", "--quiet"], {
    status: 1,
    env: { ...env, FAKE_AGENT_MODE: "failure" },
  });
  await cancel(
    "delegation-signal",
    [entries.aligndev, "code", "new", "-m", "Wait offline", "--quiet"],
    { ...env, FAKE_AGENT_MODE: "resistant" },
    () => existsSync(join(root, "agent.pid")),
    143,
  );
  await waitUntil(() => !executing(Number(readFileSync(join(root, "agent.pid"), "utf8"))));
  const records = readRecords(commands).find((record) => record.label === "delegation").observed;
  for (const record of records.filter((record) => record.argv[0]?.endsWith("/alignfirst"))) {
    assert.deepEqual(record.parentArgv.slice(0, 3), ["bunx", "--bun", "alignfirst"]);
  }
  for (const args of [
    ["config", "--json"],
    ["plans", "check", "--json"],
    ["ticket", "side-1", "--json"],
    ["ticket", "side-1", "--catchup"],
  ]) {
    assert.ok(
      records.some(
        (record) =>
          record.argv[0]?.endsWith("/alignfirst") &&
          JSON.stringify(record.argv.slice(1)) === JSON.stringify(args),
      ),
      `missing real internal ${args.join(" ")}`,
    );
  }
}

function companionAndCustomRoots() {
  const companionName = "runtime companion '$";
  const companion = join(process.env.HOME, ".alignfirst/companions", companionName);
  mkdirSync(join(companion, "docs"), { recursive: true });
  writeFileSync(
    join(companion, "docs/runtime.md"),
    "# Companion Runtime\n\nOffline companion documentation.\n",
  );
  writeFileSync(
    join(process.env.HOME, ".alignfirst/companions/registry.json"),
    JSON.stringify({
      projects: {
        [root]: { dir: companionName, items: { docs: "companion", ".plans": "project" } },
      },
    }),
  );
  const context = af("companion-context", ["context"], { contains: "Companion Runtime" });
  check(
    "companion-delegation-reservation",
    "bunx",
    [
      "--bun",
      "aligndev",
      "code",
      "new",
      "--no-ticket",
      "--protocol",
      "spec",
      "-m",
      "Offline companion",
      "--quiet",
    ],
    { runtime: "bun", env: { PATH: `${join(root, "fake-bin")}:${baseEnvironment.PATH}` } },
  );
  const internal = readRecords(commands).find(
    (record) => record.label === "companion-delegation-reservation",
  ).observed;
  for (const args of [["context"], ["ticket", "--side", "--json"]]) {
    assert.ok(
      internal.some(
        (record) =>
          record.argv[0]?.endsWith("/alignfirst") &&
          JSON.stringify(record.argv.slice(1)) === JSON.stringify(args),
      ),
    );
  }
  assert.ok(readFileSync(join(root, "delegated-prompt.txt"), "utf8").includes("Companion Runtime"));
  shell(
    "emitted-companion-docmap-guide",
    context.match(/`(bunx --bun alignfirst docmap [^`]+--guide)`/)[1],
    "bun",
  );
  af("companion-docmap-read", ["docmap", "runtime.md"], {
    contains: "Offline companion documentation",
  });
  const guide = check(
    "custom-root-guide",
    "bunx",
    ["--bun", "@alignfirst/docmap", "--root", join(companion, "docs"), "--guide"],
    { runtime: "bun" },
  );
  const emitted = guide
    .split("\n")
    .find(
      (line) =>
        line.startsWith("bunx --bun @alignfirst/docmap --root ") && line.includes("--check"),
    );
  assert.ok(emitted !== undefined, "custom-root guide did not emit check");
  shell("emitted-shell-sensitive-root-check", emitted.split(/\s+#/)[0].trim(), "bun");
  rmSync(join(process.env.HOME, ".alignfirst/companions/registry.json"));
  writeFileSync(
    join(root, "diagnostic.mjs"),
    "import {describeAlignfirst} from './node_modules/aligndev/dist/alignfirst-cli.js';console.log(describeAlignfirst(['bunx','--bun','alignfirst'],process.cwd(),process.env));\n",
  );
  check("actual-version-diagnostic", bun, [join(root, "diagnostic.mjs")], {
    runtime: "bun",
    contains: "explicit Bun runtime",
  });
  const diagnostics = readRecords(commands).find(
    (record) => record.label === "actual-version-diagnostic",
  ).observed;
  assert.ok(
    diagnostics.some(
      (record) => record.argv[0]?.endsWith("/alignfirst") && record.argv[1] === "--version",
    ),
  );
}

function exampleCommand(text, prefix) {
  const line = text.split("\n").find((candidate) => candidate.startsWith(prefix));
  assert.ok(line !== undefined, `No emitted example: ${prefix}`);
  return line.split(/\s+#/)[0].trim();
}

function workspaceLifecycle(executable = bun, runtime = "bun") {
  const project = join(output, `${tier} ${runtime} workspace`);
  const linked = join(output, `${tier} ${runtime} linked with spaces`);
  const probes = join(output, `${tier}-${runtime}-workspace-probes.jsonl`);
  // A Bun CLI may deliberately run a Node project command; those are separate runtime claims.
  const projectRuntime = tier === "matrix" ? node : bun;
  prepareWorkspaceFixture(project, probes, projectRuntime);
  const invoke = (label, args, cwd = project) =>
    check(`${runtime}-${label}`, executable, [entries.alignfirst, ...args], { runtime, cwd });
  for (const args of [
    ["init", "-b", "main"],
    ["add", "."],
    ["commit", "-m", "workspace fixture"],
  ])
    check(`${runtime}-workspace-git`, "git", args, { cwd: project });
  const before = readRecords(audit).length;
  try {
    invoke("workspace-guide", ["workspace", "--guide"]);
    invoke("workspace-detached-setup", [
      "workspace",
      "setup",
      "-c",
      "runtime-child",
      "--path",
      linked,
      "-d",
    ]);
    invoke("workspace-wait", ["workspace", "wait", linked]);
    assert.ok(existsSync(join(linked, ".local-wt/finalized.txt")));
    for (const path of ["package.json", "node_modules", "dist"])
      assert.equal(existsSync(join(linked, path)), false);
    invoke("dev-up", ["dev", "up"], linked);
    invoke("dev-down-all", ["dev", "down", "--all"]);
    invoke("workspace-teardown", ["workspace", "teardown", linked]);
    invoke("workspace-reregister", ["workspace", "setup"], linked);
    invoke("workspace-remove-from-target", ["workspace", "remove", "--force"], linked);
    assert.equal(existsSync(linked), false);
    assert.equal(readFileSync(join(project, ".plans/preserved.txt"), "utf8"), "preserve plans");
    verifyWorkspaceRuntime({
      before,
      project,
      linked,
      executable,
      runtime,
      probes,
      projectRuntime,
    });
  } finally {
    invoke("workspace-cleanup-stop", ["dev", "down", "--all"]);
    if (existsSync(linked))
      invoke("workspace-cleanup-remove", ["workspace", "remove", linked, "--force"]);
  }
}

function prepareWorkspaceFixture(project, probes, projectRuntime) {
  mkdirSync(join(project, ".plans"), { recursive: true });
  writeFileSync(join(project, ".plans/preserved.txt"), "preserve plans");
  writeFileSync(join(project, ".gitignore"), ".plans/\n.local-wt/\n");
  writeFileSync(
    join(project, "probe.mjs"),
    `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const context=JSON.parse(process.env.ALIGNFIRST_WORKSPACE_CONTEXT);
appendFileSync(${JSON.stringify(probes)},JSON.stringify({context,cwd:process.cwd(),executable:process.execPath,runtime:process.versions.bun===undefined?'node':'bun',parentArgv:readFileSync('/proc/'+process.ppid+'/cmdline','utf8').split('\\0').filter(Boolean)})+'\\n');
if(context.phase==='finalize') writeFileSync(context.runtimeDir+'/finalized.txt','ready');
if(process.argv[2]==='serve'){console.log('RUNTIME_READY');setInterval(()=>{},1000);}
`,
  );
  const probe = (action) => ({ run: [projectRuntime, "probe.mjs", action] });
  writeFileSync(
    join(project, "alignfirst.json"),
    JSON.stringify({
      schemaVersion: 1,
      workspace: {
        finalize: [{ name: "runtime evidence", ...probe("finalize") }],
        purge: [{ name: "purge evidence", ...probe("purge") }],
      },
      devServer: {
        servers: [
          { kind: "command", name: "resource", start: probe("start"), stop: probe("stop") },
          {
            kind: "spawn",
            name: "application",
            exec: probe("serve"),
            ready: { log: "RUNTIME_READY" },
          },
        ],
      },
    }),
  );
}

function verifyWorkspaceRuntime({
  before,
  project,
  linked,
  executable,
  runtime,
  probes,
  projectRuntime,
}) {
  const observed = readRecords(audit)
    .slice(before)
    .filter((record) => /\/alignfirst(?:\.mjs)?$/.test(record.argv[0] ?? ""));
  for (const args of [
    ["workspace", "__finalize"],
    ["dev", "down"],
    ["workspace", "remove"],
  ]) {
    const child = observed.find(
      (record) =>
        record.argv.slice(1, 3).join(" ") === args.join(" ") &&
        (args[1] === "remove" ? record.cwd === project : record.cwd === linked),
    );
    assert.ok(child, `missing installed child ${args.join(" ")}`);
    assert.equal(child.runtime, runtime);
    assert.equal(child.executable, executable);
    assert.equal(
      child.entry,
      entries.alignfirst.replace("/.bin/alignfirst", "/alignfirst/bin/alignfirst.mjs"),
    );
  }
  const actions = readRecords(probes);
  for (const phase of ["finalize", "start", "stop", "purge"]) {
    const action = actions.find((record) => record.context.phase === phase);
    assert.ok(action, `missing project ${phase}`);
    assert.equal(action.cwd, linked);
    assert.equal(action.context.currentWorktree, linked);
    assert.equal(action.context.name, `${tier} ${runtime} linked with spaces`);
    assert.equal(action.runtime, tier === "matrix" ? "node" : "bun");
    assert.equal(action.executable, projectRuntime);
  }
}

async function harnessLifecycle() {
  const fakeBin = join(root, "docker-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "docker"),
    `#!${bun}\n${readFileSync(join(root, "fake-docker.mjs"), "utf8")}`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${fakeBin}:${baseEnvironment.PATH}`,
    FAKE_DOCKER_LOG: join(root, "docker.jsonl"),
    OPENCLAW_WORKSPACE_DIR: join(root, "workspace"),
    OPENCLAW_TEST_PROJECT_DIR: root,
    OPENCLAW_TEST_MODELS: "local/offline",
    HARNESS_PRIVATE_KEY: "packed-private-key",
  };
  const harness = (label, args, options = {}) =>
    check(label, "bunx", ["--bun", "@alignfirst/openclaw-test", ...args], {
      runtime: "bun",
      env,
      ...options,
    });
  const initialized = harness("harness-init", ["init", root], {
    contains: "bun --bun run env:build",
  });
  assert.ok(initialized.includes("node:26 npm install"));
  writeFileSync(
    join(root, "openclaw.json"),
    JSON.stringify({
      channels: { mock: {} },
      agents: { entries: { main: {} } },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exercise config secret expansion.
      models: { providers: { local: { apiKey: "${HARNESS_PRIVATE_KEY}" } } },
    }),
  );
  mkdirSync(join(root, "workspace"), { recursive: true });
  mkdirSync(join(root, "scenarios"), { recursive: true });
  for (const name of ["case", "first", "second"])
    writeFileSync(join(root, "scenarios", `${name}.ts`), "export default async function () {}\n");
  assert.ok(initialized.includes("bun --bun run env:build"));
  check("generated-harness-env-down", "/bin/sh", ["-c", "bun --bun run env:down"], {
    runtime: "bun",
    env,
  });
  harness("harness-fake-run", ["run", "--channel", "mock", "--model", "offline", "case"], {
    contains: "FAKE_RUN_STDOUT",
  });
  harness("harness-failure", ["run", "--channel", "mock", "--model", "offline", "case"], {
    status: 7,
    env: { ...env, FAKE_FAIL_UP: "7" },
  });
  const configPaths = () =>
    readRecords(env.FAKE_DOCKER_LOG)
      .filter((call) => call.args?.includes("up"))
      .map((call) => call.config);
  harness("harness-warm-up", ["env", "up"]);
  let previous = configPaths().at(-1);
  assert.ok(existsSync(previous));
  assert.equal(statSync(previous).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(previous)).mode & 0o777, 0o700);
  assert.ok(previous.startsWith(join(process.env.HOME, ".local/state/openclaw-test/")));
  assert.ok(readFileSync(previous, "utf8").includes("packed-private-key"));
  for (const iteration of [1, 2]) {
    const before = readRecords(env.FAKE_DOCKER_LOG).length;
    harness(`harness-warm-run-${iteration}`, [
      "run",
      "--channel",
      "mock",
      "--model",
      "offline",
      "case",
    ]);
    assert.equal(existsSync(previous), false, "superseded warm config was not collected");
    previous = configPaths().at(-1);
    assert.ok(existsSync(previous), "mounted warm config was removed");
    assert.equal(
      readRecords(env.FAKE_DOCKER_LOG)
        .slice(before)
        .filter((call) => call.args?.at(-1) === "down").length,
      0,
    );
  }
  const mixedBefore = readRecords(env.FAKE_DOCKER_LOG).length;
  harness("harness-mixed-warm-new", [
    "run",
    "--channel",
    "mock",
    "--model",
    "offline",
    "--parallel",
    "2",
    "first",
    "second",
  ]);
  const mixedDowns = readRecords(env.FAKE_DOCKER_LOG)
    .slice(mixedBefore)
    .filter((call) => call.args?.at(-1) === "down");
  assert.equal(mixedDowns.length, 1);
  assert.ok(mixedDowns[0].args[mixedDowns[0].args.indexOf("-p") + 1].endsWith("-w2"));
  previous = configPaths().at(-1);
  assert.ok(existsSync(previous));
  harness("harness-warm-down", ["env", "down"]);
  assert.equal(existsSync(previous), false);
  harness("harness-failing-down", ["run", "--channel", "mock", "--model", "offline", "case"], {
    status: 9,
    env: { ...env, FAKE_FAIL_DOWN: "9" },
  });
  previous = configPaths().at(-1);
  assert.ok(existsSync(previous));
  harness("harness-failing-down-recovery", ["env", "down"]);
  assert.equal(existsSync(previous), false);
  check("harness-real-offline-imports", bun, [join(root, "runtime-helpers.mjs")], {
    runtime: "bun",
    contains: "SQLITE_ZSTD_OK",
  });
  await cancel(
    "harness-signal",
    [entries["openclaw-test"], "env", "up"],
    { ...env, FAKE_HANG: "up" },
    "FAKE_RUNNING",
    143,
  );
  harness("harness-env-signal-recovery", ["env", "down"]);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const before = readRecords(env.FAKE_DOCKER_LOG).length;
    await cancel(
      `harness-down-${signal}`,
      [
        entries["openclaw-test"],
        "run",
        "--channel",
        "mock",
        "--model",
        "offline",
        "--parallel",
        "2",
        "first",
        "second",
      ],
      { ...env, FAKE_HANG: "down", FAKE_HANG_WORKER: "2", FAKE_FAIL_DOWN: "9" },
      "FAKE_RUNNING",
      signal === "SIGINT" ? 130 : 143,
      signal,
    );
    const calls = readRecords(env.FAKE_DOCKER_LOG).slice(before);
    assert.equal(calls.filter((call) => call.args?.at(-1) === "down").length, 2);
    const config = calls.find((call) => call.args?.includes("run")).config;
    assert.equal(existsSync(config), true, "cancelled teardown removed retained config");
    harness(`harness-down-${signal}-recovery`, ["env", "down"]);
    assert.equal(existsSync(config), false, "successful recovery retained unreferenced config");
  }
  await cancel("harness-bus", [entries["openclaw-test"], "bus"], env, "bus listening");
  for (const record of readRecords(join(root, "docker.jsonl"))) {
    for (const pid of [record.pid, record.worker])
      if (pid !== undefined) await waitUntil(() => !executing(pid));
  }
}

async function cancel(label, args, extra, ready, expected, signal = "SIGTERM") {
  const child = spawn(bun, args, {
    cwd: root,
    env: { ...baseEnvironment, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.on("data", (chunk) => {
    text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    text += chunk;
  });
  let didClose = false;
  const closed = new Promise((resolve) =>
    child.once("close", (status, signal) => {
      didClose = true;
      resolve({ status, signal });
    }),
  );
  try {
    await waitUntil(typeof ready === "function" ? ready : () => text.includes(ready));
    child.kill(signal);
    await waitUntil(() => didClose);
    const result = await closed;
    if (expected !== undefined) assert.equal(result.status, expected, text);
    appendFileSync(
      commands,
      `${JSON.stringify({ label, command: bun, args, ...result, output: text })}\n`,
    );
    console.log(`PASS ${label}`);
  } finally {
    if (!didClose) child.kill("SIGKILL");
    await closed;
  }
}

function check(label, executable, args, options = {}) {
  const before = readRecords(audit).length;
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? root,
    env: { ...baseEnvironment, ...options.env },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const observed = readRecords(audit).slice(before);
  appendFileSync(
    commands,
    `${JSON.stringify({ label, executable, args, status: result.status, signal: result.signal, observed, stdout: result.stdout, stderr: result.stderr })}\n`,
  );
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(result.status, options.status ?? 0, `${label}: ${result.stdout}\n${result.stderr}`);
  if (options.contains !== undefined)
    assert.ok(
      `${result.stdout}${result.stderr}`.includes(options.contains),
      `${label}: missing ${options.contains}\n${result.stdout}\n${result.stderr}`,
    );
  if (options.runtime !== undefined) {
    const firstParty = observed.filter(
      (record) =>
        record.argv[0]?.includes("node_modules") &&
        !record.argv[0]?.includes("npm/bin") &&
        !record.argv[0]?.includes("bunx"),
    );
    // Preload logs identify the actual executable even when Bun's user agent advertises Node.
    assert.ok(
      firstParty.length > 0 ||
        observed.some(
          (record) =>
            record.argv[0]?.endsWith("workspace.mjs") ||
            record.argv[0]?.endsWith("runtime-helpers.mjs") ||
            record.argv[0]?.endsWith("dev.mjs"),
        ),
      `${label}: no runtime evidence`,
    );
    for (const record of firstParty)
      assert.equal(record.runtime, options.runtime, `${label}: ${JSON.stringify(record)}`);
  }
  console.log(`PASS ${label}`);
  return `${result.stdout}${result.stderr}`;
}

function readRecords(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out joining owned runtime child");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function executing(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}
