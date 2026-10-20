import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = process.cwd();
const names = process.argv.slice(2);
const agentDir = join(root, "presentation-agent");
const cwd = join(root, "presentation-project");
const requested = join(agentDir, "provider-requested");

await verifyPresentation();

async function verifyPresentation() {
  preparePresentation();
  await verifyNpmResources();
  verifyCompactLabels(captureStartup());
  assert(!existsSync(requested), "Label-only TUI startup made no provider request");
  console.log(`Packed native TUI presentation passed: ${names.join(", ")}.`);
}

function preparePresentation() {
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, "npm"), { recursive: true });
  // Pi's managed npm location uses the already-installed tarballs, never a registry replacement.
  symlinkSync(join(root, "node_modules"), join(agentDir, "npm/node_modules"), "dir");
  const rejectNpm = join(agentDir, "reject-npm.mjs");
  writeFileSync(rejectNpm, 'throw new Error("Unexpected npm command in packed presentation");\n');
  const guard = join(agentDir, "presentation-guard.mjs");
  writeFileSync(
    guard,
    `import { writeFileSync } from "node:fs";
export default function(pi) {
  pi.on("before_provider_request", () => {
    writeFileSync(${JSON.stringify(requested)}, "unexpected request");
    throw new Error("Presentation startup must not call a provider");
  });
}
`,
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: names.map((name) => `npm:${name}`),
      extensions: [
        join(root, "pi-smoke-provider.mjs"),
        guard,
        "-builtin:mcp",
        "-builtin:llama.cpp",
        "-builtin:codemode",
        "-builtin:tool-search",
      ],
      npmCommand: [process.execPath, rejectNpm],
      defaultProvider: "packed-fixture",
      defaultModel: "local",
      quietStartup: false,
      theme: "dark",
      enableInstallTelemetry: false,
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
}

async function verifyNpmResources() {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
  assert.deepEqual(
    tools.sort(),
    names.map((name) => (name.endsWith("subagent") ? "subagent" : "background")).sort(),
    "Npm sources register each tool exactly once",
  );
  for (const name of names) {
    const extensions = loaded.extensions.filter(
      (extension) => extension.sourceInfo?.source === `npm:${name}`,
    );
    assert.equal(extensions.length, 1);
    assert.equal(
      realpathSync(extensions[0].path),
      realpathSync(join(root, "node_modules", name, "index.js")),
      "Npm source resolves to the packed root forwarder",
    );
  }
}

function captureStartup() {
  return execFileSync(
    "python3",
    [
      join(root, "pi-packed-tui.py"),
      process.execPath,
      join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    ],
    {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TERM: "xterm-256color" },
      encoding: "utf8",
      timeout: 40000,
    },
  );
}

function verifyCompactLabels(output) {
  const text = stripVTControlCharacters(output);
  const listing = text.match(/\[Extensions\]\s*\n([^\n]+)/)?.[1];
  assert(listing !== undefined, `Missing native compact extension listing:\n${text}`);
  for (const name of names) {
    assert(listing.includes(name), `Missing native package label ${name}: ${listing}`);
    assert.equal(listing.split(name).length - 1, 1, `Duplicate package label: ${listing}`);
    assert(!listing.includes(`${name}:`), `Unexpected package-path suffix: ${listing}`);
  }
  assert(!text.includes(":dist"), text);
  assert(!text.includes("[Extension issues]"), text);
}
