import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeAdapter } from "../../dist/code/claude-agent.js";
import { readMachineId } from "../../dist/code/machine-id.js";
import { createExecutableModelResolver } from "../../dist/code/models.js";
import { runQuotaProcess } from "../../dist/code/quota-process.js";
import { runAgent } from "../../dist/code/run-agent.js";
import {
  completedSessionPath,
  readCompletion,
  readPidStartTime,
  reconcileSessionFile,
  writeInitialSessionFile,
} from "../../dist/code/session-file.js";

const cwd = process.argv[2];
const children = [];
const closedChildren = new WeakSet();

try {
  await checkAgent();
  await checkQuota();
  await checkInheritedPipes();
  await checkCatalog();
  await checkSessionIdentity();
  assert.equal(readMachineId(cwd), readMachineId(cwd));
  assert.match(readPidStartTime(process.pid), /^\d+$/);
  console.log(
    JSON.stringify({ runtime: process.versions.bun ?? process.version, checks: "passed" }),
  );
} finally {
  for (const child of children) {
    if (!closedChildren.has(child)) child.kill("SIGKILL");
    if (!closedChildren.has(child)) {
      await new Promise((resolve) => child.once("close", resolve));
    }
  }
}

async function checkAgent() {
  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "offline" });
  const result = JSON.stringify({
    type: "result",
    session_id: "offline",
    result: "trailing result",
    is_error: false,
  });
  for (const [name, script, success, prompt] of [
    [
      "trailing",
      `let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { if (input !== 'prompt') process.exit(9); process.stdout.write(${JSON.stringify(`${init}\n${result}`)}); });`,
      true,
      "prompt",
    ],
    ["nonzero", "process.stderr.write('offline failure'); process.exit(7);", false, "prompt"],
    [
      "epipe",
      "require('node:fs').closeSync(0); setTimeout(() => process.exit(7), 20);",
      false,
      "x".repeat(4_000_000),
    ],
    ["startup", undefined, false, "prompt"],
  ]) {
    const sessionFilePath = join(cwd, `${name}.running.md`);
    writeInitialSessionFile(sessionFilePath, {
      status: "running",
      agent: "claude",
      profile: null,
      protocol: null,
      ticket: null,
      model: null,
      sessionId: null,
      command: "offline fixture",
      meta: null,
      pid: process.pid,
      pidStartTime: readPidStartTime(process.pid),
      machineId: readMachineId(cwd),
      cwd,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitReason: null,
      contextTokens: null,
      contextCompacted: false,
      contextTokensError: null,
    });
    const config = {
      prompt,
      sessionFilePath,
      cwd,
      executableModel: undefined,
      skipPermissions: false,
      additionalDirectories: [],
      env: {},
      quiet: true,
    };
    const result = await runAgent(
      config,
      createClaudeAdapter(),
      { write() {} },
      (_command, _args, options) =>
        own(
          script === undefined
            ? spawn(join(cwd, "missing-agent"), [], options)
            : spawn(process.execPath, ["-e", script], options),
        ),
    );
    assert.equal(result.status, success ? "succeeded" : "failed", name);
    assert.equal(existsSync(sessionFilePath), false);
    assert.equal(existsSync(completedSessionPath(sessionFilePath)), true);
    assert.equal(
      readCompletion(completedSessionPath(sessionFilePath)).frontmatter.status,
      result.status,
    );
    if (success) assert.equal(result.result, "trailing result");
  }
}

async function checkQuota() {
  const before = process.listenerCount("exit");
  for (const [script, expected, timeoutMs] of [
    [
      "process.on('SIGTERM', () => {}); process.stdin.resume(); process.stdout.write('ready'); setInterval(() => {}, 1000);",
      "ok",
      2000,
    ],
    ["process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", /timed out/, 100],
    [
      "process.stdout.write('x'.repeat(1_048_577)); setInterval(() => {}, 1000);",
      /output exceeded/,
      2000,
    ],
    ["require('node:fs').closeSync(0); process.exit(7);", /could not write|exited before/, 2000],
  ]) {
    const child = own(
      spawn(process.execPath, ["-e", script], { cwd, env: {}, stdio: ["pipe", "pipe", "pipe"] }),
    );
    const result = runQuotaProcess(child, {
      source: "offline",
      timeoutMs,
      start: (write) => write({ request: "usage" }),
      stdout: (chunk) => (chunk === "ready" ? "ok" : undefined),
    });
    if (expected === "ok") assert.equal(await result, expected);
    else await assert.rejects(result, expected);
    assert.ok(
      child.exitCode !== null || child.signalCode !== null,
      "quota child reaped before settlement",
    );
    assert.equal(child.stdin.writableEnded || child.stdin.destroyed, true);
    assert.equal(process.listenerCount("exit"), before);
  }
}

async function checkInheritedPipes() {
  const before = process.listenerCount("exit");
  const script = `
process.on("SIGTERM", () => {});
const holder = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000);"], { stdio: ["ignore", 1, 2] });
require("node:fs").writeFileSync(${JSON.stringify(join(cwd, "pipe-owner.pid"))}, String(holder.pid));
process.stdout.write("ready");
process.stdin.resume();
setInterval(() => {}, 1000);`;
  const child = own(
    spawn(process.execPath, ["-e", script], { cwd, env: {}, stdio: ["pipe", "pipe", "pipe"] }),
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  const result = runQuotaProcess(child, {
    source: "offline",
    timeoutMs: 5000,
    stdout: () => "ok",
  });
  // Observe ownership during the TERM grace period, before KILL ends the direct child.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    process.listenerCount("exit") > before,
    "exit guard retained while child remains owned",
  );
  try {
    await assert.rejects(result, /cleanup did not complete/);
    await closed;
    assert.equal(process.listenerCount("exit"), before);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  } finally {
    const pid = Number(readFileSync(join(cwd, "pipe-owner.pid"), "utf8"));
    await stopPipeOwner(pid);
  }
}

async function stopPipeOwner(pid) {
  if (isExecuting(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 3000;
  while (isExecuting(pid)) {
    assert.ok(Date.now() < deadline, "pipe holder stopped");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function checkCatalog() {
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const executable = join(bin, "codex");
  for (const [script, success] of [
    [
      "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ models: [{slug:'gpt-9-terra'}] })));",
      true,
    ],
    ["process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));", false],
  ]) {
    writeFileSync(executable, `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
    const result = createExecutableModelResolver()("codex", "terra", { cwd, env: { PATH: bin } });
    if (success) assert.equal(await result, "gpt-9-terra");
    else await assert.rejects(result, /Unable to resolve Codex/);
  }
  assert.ok(readFileSync(executable, "utf8").startsWith(`#!${process.execPath}`));
}

async function checkSessionIdentity() {
  const home = join(cwd, "concurrent-home");
  const moduleUrl = new URL("../../dist/code/machine-id.js", import.meta.url).href;
  const ids = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise((resolve, reject) => {
          const script = `import { readMachineId } from ${JSON.stringify(moduleUrl)}; console.log(readMachineId(${JSON.stringify(home)}));`;
          const child = own(
            spawn(process.execPath, ["--input-type=module", "-e", script], {
              stdio: ["ignore", "pipe", "pipe"],
            }),
          );
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr.resume();
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0
              ? resolve(output.trim())
              : reject(new Error(`machine-id fixture exited ${code}`)),
          );
        }),
    ),
  );
  assert.equal(new Set(ids).size, 1);
  assert.equal(ids[0], readMachineId(home));
  const initial = readCompletion(join(cwd, "trailing.md")).frontmatter;
  for (const [name, machineId, pidStartTime, status] of [
    ["live", initial.machineId, readPidStartTime(process.pid), "running"],
    ["reused", initial.machineId, "0", "failed"],
    ["foreign", "foreign-machine", "0", "running"],
    ["legacy", null, "0", "running"],
    ["uncertain", initial.machineId, null, "running"],
  ]) {
    const path = join(cwd, `${name}.running.md`);
    writeInitialSessionFile(path, { ...initial, status: "running", machineId, pidStartTime });
    const reconciled = reconcileSessionFile(path, initial.machineId);
    assert.equal(reconciled.frontmatter.status, status, name);
    assert.equal(existsSync(path), status === "running");
  }
}

function isExecuting(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

function own(child) {
  children.push(child);
  child.once("close", () => closedChildren.add(child));
  return child;
}
