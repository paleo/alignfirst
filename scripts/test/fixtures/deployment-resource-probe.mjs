import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  DefaultResourceLoader,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Prompt construction is not exported; inspect the pinned implementation in this isolated process.
const { buildSystemPrompt } = await import(
  new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
);
const root = process.env.DEPLOYMENT_FIXTURE_ROOT;
assert(root !== undefined, "Only run through the disposable deployment test harness");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, ".pi/agent");
assert(realpathSync(agentDir).startsWith(`${realpathSync(root)}${sep}`));
const cwd = process.cwd();
assert(realpathSync(cwd).startsWith(`${realpathSync(root)}${sep}`));

await main();

async function main() {
  const settings = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
  await loader.reload();
  const baseline = promptFrom(loader);
  for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
    writeFileSync(join(agentDir, name), "");
  }
  await loader.reload();
  assert.equal(loader.getSystemPrompt(), "");
  assert.equal(promptFrom(loader), baseline, "Empty reservations must preserve the native prompt");
  writeFileSync(join(agentDir, "AGENTS.override.md"), "Fixture override instructions");
  writeFileSync(join(agentDir, "AGENTS.md"), "Fixture lower-priority instructions");
  await loader.reload();
  const instructions = loader.getAgentsFiles().agentsFiles;
  assert(instructions.some((file) => file.content === "Fixture override instructions"));
  assert(!instructions.some((file) => file.content === "Fixture lower-priority instructions"));
  rmSync(join(agentDir, "AGENTS.override.md"));
  mkdirSync(join(agentDir, "AGENTS.override.md"));
  await loader.reload();
  assert(
    loader
      .getAgentsFiles()
      .agentsFiles.some((file) => file.content === "Fixture lower-priority instructions"),
    "Directory sentinels reserve alternate instructions without hiding AGENTS.md",
  );

  const child = join(cwd, "worktrees/one");
  mkdirSync(child, { recursive: true });
  const store = new ProjectTrustStore(agentDir);
  store.set(cwd, true);
  assert.equal(new ProjectTrustStore(agentDir).get(child), true);
  store.set(join(cwd, "worktrees"), false);
  assert.equal(new ProjectTrustStore(agentDir).get(child), false);
  assert(existsSync(join(agentDir, "trust.json")));

  settings.setDefaultThinkingLevel("low");
  await settings.flush();
  assert.deepEqual(settings.drainErrors(), []);
  assert.equal(
    JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).defaultThinkingLevel,
    "low",
  );
  assert(!existsSync(join(agentDir, "settings.json.lock")));
  console.log(
    JSON.stringify({
      emptyPromptReservationsNeutral: true,
      alternateInstructionsDiscovered: true,
      parentTrustInherited: true,
      closerTrustOverrides: true,
      nativeSettingsPersisted: true,
    }),
  );
}

function promptFrom(loader) {
  return buildSystemPrompt({
    cwd,
    customPrompt: loader.getSystemPrompt(),
    appendSystemPrompt: loader.getAppendSystemPrompt().join("\n\n"),
    contextFiles: loader.getAgentsFiles().agentsFiles,
  });
}
