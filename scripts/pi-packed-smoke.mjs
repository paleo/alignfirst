import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = process.cwd();
const names = process.argv.slice(2);
const paths = names.map((name) => join(root, "node_modules", name));
const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = join(root, "project");
const provider = join(root, "pi-smoke-provider.mjs");
const errors = [];
let requests = 0;
let blocker;
let held;

mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({
    extensions: [provider],
    defaultProvider: "packed-fixture",
    defaultModel: "local",
    compaction: { enabled: false },
    retry: { enabled: false },
  }),
);
await verifyLoadSideEffects();
const runtime = await createRuntime();
try {
  assert.deepEqual(
    runtime.session.getActiveToolNames().sort(),
    names.map((name) => (name.endsWith("subagent") ? "subagent" : "background")).sort(),
  );
  if (names.some((name) => name.endsWith("subagent"))) {
    for (const input of [
      { task: "Return the fixture answer" },
      { tasks: [{ task: "one" }, { task: "two" }] },
    ]) {
      const result = await call("subagent", input);
      assert.equal(result.isError, false, JSON.stringify(result));
      assert(
        result.structuredContent.results.every(
          (r) => r.output === "PACKED-CHILD-OK" && r.agentSource === "bundled",
        ),
      );
    }
  }
  if (names.length === 2 && process.platform === "linux") {
    const nested = await nestedSubagent("interruption");
    nested.controller.abort();
    await verifyNestedStopped(nested);
  }
  if (names.some((name) => name.endsWith("background"))) {
    await scheduling();
    for (const operation of ["new", "resume", "fork", "reload", "quit"])
      await retirement(operation);
  }
  assert.deepEqual(errors, []);
  console.log(
    `Packed standalone smoke passed: ${names.join(", ")}; ${requests} deterministic parent requests.`,
  );
} finally {
  blocker?.resolve();
  await runtime.dispose();
}

async function verifyLoadSideEffects() {
  const settingsManager = SettingsManager.inMemory({});
  const load = async (additionalExtensionPaths) => {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      additionalExtensionPaths,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    return loader;
  };
  await load([]);
  const before = process
    .getActiveResourcesInfo()
    .filter((type) => type === "Timeout" || type === "ProcessWrap");
  const loader = await load(paths);
  assert.deepEqual(
    process.getActiveResourcesInfo().filter((type) => type === "Timeout" || type === "ProcessWrap"),
    before,
    "Extension load creates no process/timer beyond host initialization",
  );
  const extensions = loader.getExtensions().extensions;
  assert.equal(extensions.length, names.length);
  const tools = extensions.flatMap((extension) => [...extension.tools.keys()]);
  assert.equal(new Set(tools).size, names.length);
  assert(paths.every((path) => extensions.some((extension) => extension.path.startsWith(path))));
  assert.deepEqual(loader.getSkills().skills, []);
}

async function createRuntime() {
  const result = await createAgentSessionRuntime(
    async ({ cwd: target, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd: target,
        agentDir,
        settingsManager: SettingsManager.inMemory({
          defaultProvider: "packed-fixture",
          defaultModel: "local",
          compaction: { enabled: false, keepRecentTokens: 1 },
          retry: { enabled: false },
        }),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noThemes: true,
          noPromptTemplates: true,
          noContextFiles: true,
          additionalExtensionPaths: [...paths, provider],
          extensionFactories: [
            (pi) => {
              pi.on("before_provider_request", async (_event, ctx) => {
                ++requests;
                if (held) {
                  held.resolve();
                  await Promise.race([
                    blocker.promise,
                    new Promise((resolve) =>
                      ctx.signal?.addEventListener("abort", resolve, { once: true }),
                    ),
                  ]);
                }
              });
              pi.on("session_before_compact", async (event) => {
                if (!blocker) return;
                held.resolve();
                await blocker.promise;
                return {
                  compaction: {
                    summary: "packed summary",
                    firstKeptEntryId: event.preparation.firstKeptEntryId,
                    tokensBefore: event.preparation.tokensBefore,
                  },
                };
              });
              pi.on("session_before_tree", async () => {
                if (!blocker) return;
                held.resolve();
                await blocker.promise;
                return { cancel: true };
              });
            },
          ],
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: names.map((name) => (name.endsWith("subagent") ? "subagent" : "background")),
      });
      return { ...created, services, diagnostics: services.diagnostics };
    },
    { cwd, agentDir, sessionManager: SessionManager.create(cwd, join(root, "sessions")) },
  );
  const bind = async () => {
    await result.session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
  };
  result.setRebindSession(bind);
  await bind();
  return result;
}

async function call(name, input, signal) {
  const tool = runtime.session.agent.state.tools.find((tool) => tool.name === name);
  assert(tool, `Missing tool ${name}`);
  return tool.execute("packed-smoke", input, signal);
}

async function background(input) {
  return (await call("background", input)).structuredContent;
}

async function scheduling() {
  await runtime.session.prompt("seed");
  const target = runtime.session.sessionManager.getLeafId();
  await runtime.session.prompt("seed two");
  for (const operation of ["compact", "cancelledTree"]) {
    blocker = gate();
    held = gate();
    const job = (
      await background({
        action: "start",
        command: `while [ ! -f ${operation} ]; do sleep 0.02; done`,
      })
    ).job;
    const pending =
      operation === "compact" ? runtime.session.compact() : runtime.session.navigateTree(target);
    await held.promise;
    const count = requests;
    writeFileSync(join(cwd, operation), "go");
    await waitJob(job.id);
    assert.equal(requests, count, "No model request inside protected operation");
    blocker.resolve();
    await pending;
    blocker = undefined;
    held = undefined;
    await runtime.session.prompt("recover");
    assert(notices().some((notice) => notice.includes(job.id)));
  }
  for (const replacement of ["reload", "tree"]) {
    const busy = gate();
    blocker = busy;
    held = gate();
    const running = runtime.session.prompt("busy");
    await held.promise;
    const job = (await background({ action: "start", command: "exit 7" })).job;
    await waitJob(job.id);
    const aborting = runtime.session.abort();
    busy.resolve();
    await aborting;
    await running;
    blocker = undefined;
    held = undefined;
    const session = runtime.session;
    const clearQueue = session.clearQueue;
    let queueRewrites = 0;
    session.clearQueue = function (...args) {
      ++queueRewrites;
      return clearQueue.apply(this, args);
    };
    try {
      if (replacement === "reload") await session.reload();
      else await session.navigateTree(target);
      await assert.rejects(() => background({ action: "status", id: job.id }), /handle/);
      await session.prompt("later");
      const stale = notices().find((notice) => notice.includes(job.id));
      assert(stale?.includes('"runtimeId"'));
      assert(stale.includes("Ignore unknown/retired"));
      assert.equal(queueRewrites, 0, "Extensions must not rewrite native queues");
    } finally {
      session.clearQueue = clearQueue;
    }
  }
}

function notices() {
  return runtime.session.messages
    .filter(
      (message) => message.role === "custom" && message.customType === "background-completion",
    )
    .map((message) => String(message.content));
}

async function retirement(operation) {
  await runtime.session.prompt("seed lifecycle");
  const original = runtime.session.sessionFile;
  const target = runtime.session.sessionManager
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  const nested =
    process.platform === "linux" && names.length === 2
      ? await nestedSubagent(operation)
      : undefined;
  const files = [0, 1].map((i) => join(cwd, `${operation}-${i}.pid`));
  const jobs = [];
  for (const file of files) {
    const command = `exec '${process.execPath}' -e 'require("fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'`;
    jobs.push((await background({ action: "start", command })).job);
  }
  await waitFor(() => files.every(existsSync));
  const pids = files.map((file) => Number(readFileSync(file, "utf8")));
  const started = Date.now();
  if (operation === "new") await runtime.newSession();
  else if (operation === "resume") await runtime.switchSession(original);
  else if (operation === "fork") await runtime.fork(target.id);
  else if (operation === "reload") await runtime.session.reload();
  else await runtime.dispose();
  assert(
    Date.now() - started < (nested ? 14500 : 8500),
    "Job grace periods overlap; separate extension handlers may run sequentially",
  );
  if (nested) await verifyNestedStopped(nested);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), "Direct child must be reaped");
  if (operation !== "quit")
    for (const job of jobs)
      await assert.rejects(() => background({ action: "status", id: job.id }), /handle/);
}

async function verifyNestedStopped(nested) {
  const result = await nested.pending;
  assert.equal(result.structuredContent.results[0].status, "cancelled");
  for (const record of nested.records) {
    let current;
    try {
      const stat = readFileSync(`/proc/${record.pid}/stat`, "utf8");
      current = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    assert(
      current[19] !== record.identity || current[0] === "Z",
      `Live nested descendant ${record.pid}`,
    );
  }
  delete process.env.PI_SMOKE_CHILD_COMMAND;
}

async function nestedSubagent(operation) {
  const directory = join(cwd, `${operation}-nested`);
  mkdirSync(directory);
  process.env.PI_SMOKE_CHILD_COMMAND = `'${process.execPath}' '${join(root, "pi-smoke-tree.mjs")}' '${directory}' grouped`;
  const controller = new AbortController();
  const pending = call(
    "subagent",
    {
      task: "Run the local bash fixture",
      model: "packed-fixture/local",
    },
    controller.signal,
  );
  await waitFor(() => readdirSync(directory).filter((name) => name.endsWith(".json")).length >= 3);
  const records = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
  return { pending, records, controller };
}

function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitJob(id) {
  let job;
  await waitFor(async () => {
    job = (await background({ action: "status", id })).job;
    return job.status !== "running";
  });
  return job;
}

async function waitFor(check) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Packed smoke watchdog expired");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
