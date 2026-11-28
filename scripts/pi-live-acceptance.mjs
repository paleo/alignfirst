import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "pi-live-acceptance-"));
const artifacts = mkdtempSync(join(tmpdir(), "pi-live-evidence-"));
const sourceAgent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");

try {
  assert(
    process.argv.includes("--run"),
    "Opt in explicitly with --run; this command makes live model requests.",
  );
  run();
} finally {
  rmSync(root, { recursive: true, force: true });
  console.log(`Sanitized evidence: ${artifacts}`);
}

function run() {
  const model = readAcceptanceModel();
  const agentDir = join(root, "home/.pi/agent");
  mkdirSync(agentDir, { recursive: true });
  const auth = JSON.parse(readFileSync(join(sourceAgent, "auth.json"), "utf8"));
  const provider = model.split("/")[0];
  const modelId = model.slice(provider.length + 1);
  assert(auth[provider], `BLOCKED: no existing credential for ${provider}`);
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ [provider]: auth[provider] }), {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_ACCEPTANCE_MODEL: model,
    PI_ACCEPTANCE_ARTIFACTS: artifacts,
  };
  for (const key of Object.keys(env)) {
    if (
      /API_KEY|TOKEN|SECRET|PASSWORD/.test(key) ||
      [
        "NODE_OPTIONS",
        "NODE_PATH",
        "PI_PACKAGE_DIR",
        "PI_MANAGED_INSTALL_ROOT",
        "npm_config_user_agent",
      ].includes(key)
    )
      delete env[key];
  }
  const tarballs = ["docmap", "alignfirst", "aligndev", "pi-subagent", "pi-background"].map(
    (name) => {
      const output = JSON.parse(
        execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
          cwd: join(repository, "packages", name),
          encoding: "utf8",
        }),
      );
      return join(root, (Array.isArray(output) ? output[0] : Object.values(output)[0]).filename);
    },
  );
  writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=peer",
      "--no-audit",
      "--no-fund",
      "@earendil-works/pi-coding-agent@1.4.0",
      ...tarballs,
    ],
    { cwd: root, stdio: "pipe" },
  );
  env.PATH = `${join(root, "node_modules/.bin")}:${process.env.PATH}`;
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [
        join(root, "node_modules/@alignfirst/pi-subagent"),
        join(root, "node_modules/@alignfirst/pi-background"),
      ],
      defaultProvider: provider,
      defaultModel: modelId,
      defaultThinkingLevel: "low",
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  mkdirSync(join(root, "home/.alignfirst"));
  writeFileSync(
    join(root, "home/.alignfirst/aligndev.settings.json"),
    JSON.stringify({
      code: {
        profiles: { "pi-fixture": { harness: "pi", defaultModel: `${model}:low` } },
      },
    }),
  );
  const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const catalog = execFileSync(process.execPath, [cli, "--list-models", modelId], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  writeFileSync(join(artifacts, "catalog.txt"), catalog);
  assert(
    catalog.split("\n").some((line) => {
      const [name, id] = line.trim().split(/\s+/);
      return `${name}/${id}` === model;
    }),
    "BLOCKED: requested exact provider/model absent",
  );
  execFileSync(
    process.execPath,
    [cli, "auth", "check", "--provider", provider, "--no-refresh", "--json"],
    { cwd: root, env, stdio: "pipe" },
  );
  copyFileSync(join(repository, "scripts/pi-live-runner.mjs"), join(root, "runner.mjs"));
  copyFileSync(join(repository, "scripts/pi-live-tui.py"), join(root, "pi-live-tui.py"));
  execFileSync(process.execPath, [join(root, "runner.mjs")], {
    cwd: root,
    env,
    stdio: "inherit",
    timeout: 900000,
  });
}

// The environment wins over the git-ignored scripts/.env, which keeps model versions out of git.
function readAcceptanceModel() {
  const envFile = join(repository, "scripts/.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const model = process.env.PI_ACCEPTANCE_MODEL;
  assert(
    model !== undefined && /^[^/]+\/./.test(model),
    "Set PI_ACCEPTANCE_MODEL to an explicit provider/model selector, in the environment or scripts/.env.",
  );
  return model;
}
