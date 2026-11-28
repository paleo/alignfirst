import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
const tools = names.map((name) => (name.endsWith("subagent") ? "subagent" : "background"));
const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = join(root, "project");
const provider = join(root, "pi-smoke-provider.mjs");
const errors = [];

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
  assert.deepEqual(runtime.session.getActiveToolNames().sort(), [...tools].sort());
  if (tools.includes("subagent")) await callSubagent();
  if (tools.includes("background")) await callBackground();
  assert.deepEqual(errors, []);
  console.log(`Packed standalone smoke passed: ${names.join(", ")}.`);
} finally {
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
    assert.deepEqual(loader.getExtensions().errors, [], "Packed extension loader: load errors");
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
  assert.equal(extensions.length, names.length, "Packed extension loader: extension count");
  for (const extension of extensions)
    assert.equal(extension.tools.size, 1, "Packed extension loader: one tool per factory");
  assert.deepEqual(
    extensions.flatMap((extension) => [...extension.tools.keys()]).sort(),
    [...tools].sort(),
    "Packed extension loader: exact tool registrations",
  );
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
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noThemes: true,
          noPromptTemplates: true,
          noContextFiles: true,
          additionalExtensionPaths: [...paths, provider],
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools,
      });
      return { ...created, services, diagnostics: services.diagnostics };
    },
    { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
  );
  const bind = async () => {
    await result.session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
  };
  result.setRebindSession(bind);
  await bind();
  return result;
}

async function callSubagent() {
  const result = await call("subagent", { task: "Return the fixture answer" });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.structuredContent.results[0].output, "PACKED-CHILD-OK");
}

async function callBackground() {
  const started = (await call("background", { action: "start", command: "exit 0" }))
    .structuredContent.job;
  await waitFor(async () => {
    const { job } = (await call("background", { action: "status", id: started.id }))
      .structuredContent;
    assert.notEqual(job.status, "failed", JSON.stringify(job));
    return job.status === "succeeded";
  });
}

async function call(name, input) {
  const tool = runtime.session.agent.state.tools.find((tool) => tool.name === name);
  assert(tool, `Missing tool ${name}`);
  return tool.execute("packed-smoke", input);
}

async function waitFor(check) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Packed smoke watchdog expired");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
