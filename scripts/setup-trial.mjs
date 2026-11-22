#!/usr/bin/env node
// Runs the `alignfirst setup` guide against `claude -p` in throwaway sandboxes.
// Usage: node scripts/setup-trial.mjs [--check | <scenario>... | --reply <sandbox> <message>]
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALIGNFIRST_DIST = join(ROOT, "packages/alignfirst/dist");
const LOCAL_BINS = {
  alignfirst: join(ROOT, "packages/alignfirst/bin/alignfirst.mjs"),
  aligndev: join(ROOT, "packages/aligndev/bin/aligndev.mjs"),
};
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const CREDENTIALS_FILE = ".credentials.json";
const PROMPT_PREFIX = "Run `npx -y alignfirst setup` first.";
// Copied from packages/aligndev/src/code/run-agent.ts, plus the Claude Code harness variables
// that would make the child behave as a nested session.
const ASSISTANT_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_CI",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "CLAUDE_CODE_CHILD_NOTES_DIR",
  "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS",
];
const SCENARIOS = {
  protocols: {
    request: "Set up the AlignFirst protocols in this project.",
    buildFixture: buildNodeFixture,
  },
  recommendation: {
    request: "What can I set up in this project?",
    buildFixture: buildRecommendationFixture,
  },
  workspace: {
    request: "Set up a workspace with a dev server.",
    buildFixture: buildPythonFixture,
  },
  companion: {
    request: "Use a companion directory, no footprint please.",
    buildFixture: buildNodeFixture,
  },
  "new-project": {
    request: "Prepare this project for AlignFirst and setup a node/express/react/typescript stack",
    buildFixture: () => {},
  },
};

main();

function main() {
  const args = process.argv.slice(2);
  checkPrerequisites();
  const host = readHost();
  if (args[0] === "--check") {
    checkSandbox(host);
    return;
  }
  if (args[0] === "--reply") {
    if (args.length !== 3) fail("Usage: --reply <sandbox> <message>");
    replyInSandbox(sandboxAt(resolve(args[1]), host), args[2]);
    return;
  }
  for (const name of selectScenarios(args)) runScenario(name, SCENARIOS[name], host);
}

function checkPrerequisites() {
  if (!process.env.CLAUDE_CONFIG_DIR) fail("CLAUDE_CONFIG_DIR is not set.");
  if (!existsSync(hostCredentials())) fail(`${hostCredentials()} is missing: log in first.`);
  if (!existsSync(ALIGNFIRST_DIST)) fail(`${ALIGNFIRST_DIST} is missing: run npm run build.`);
}

function hostCredentials() {
  return join(process.env.CLAUDE_CONFIG_DIR, CREDENTIALS_FILE);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readHost() {
  const nodeDir = dirname(process.execPath);
  const realNpx = join(nodeDir, "npx");
  if (!existsSync(realNpx)) fail(`No npx beside ${process.execPath}.`);
  const npm = join(nodeDir, "npm");
  return {
    realNpx,
    npmVersion: capture(npm, ["--version"]).trim(),
    npmCache: capture(npm, ["config", "get", "cache"]).trim(),
  };
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result.stdout;
}

function selectScenarios(args) {
  if (args.length === 0) return Object.keys(SCENARIOS);
  const unknown = args.filter((name) => !Object.hasOwn(SCENARIOS, name));
  if (unknown.length > 0) {
    fail(`Unknown scenario: ${unknown.join(", ")}. Known: ${Object.keys(SCENARIOS).join(", ")}.`);
  }
  return args;
}

function checkSandbox(host) {
  const sandbox = createSandbox("check", host);
  buildNodeFixture(sandbox);
  console.log(`Sandbox: ${sandbox.dir}`);
  console.log(runShim(sandbox, ["-y", "alignfirst", "setup"]).output);
  const reply = spawnSync("claude", ["-p", "Reply with OK."], {
    cwd: sandbox.project,
    env: sandbox.env,
    encoding: "utf8",
  });
  console.log(`claude exit ${reply.status}: ${reply.stdout.trim()}${reply.stderr.trim()}`);
}

function runScenario(name, scenario, host) {
  const sandbox = createSandbox(name, host);
  scenario.buildFixture(sandbox);
  console.log(`[${name}] running in ${sandbox.dir}`);
  const run = launchAgent(sandbox, [`${PROMPT_PREFIX} ${scenario.request}`], "");
  collectOutputs(sandbox, run, "");
  console.log(`[${name}] ${describeRun(run)}: ${sandbox.dir}`);
}

/** Answers the agent's question by resuming its session; outputs get a `-<n>` suffix. */
function replyInSandbox(sandbox, message) {
  const first = readTranscript(join(sandbox.out, "transcript.jsonl"));
  const sessionId = first.find((event) => event.session_id !== undefined)?.session_id;
  if (sessionId === undefined) fail(`No session ID in ${sandbox.out}/transcript.jsonl.`);
  let index = 2;
  while (existsSync(join(sandbox.out, `transcript-${index}.jsonl`))) ++index;
  const suffix = `-${index}`;
  console.log(`[reply${suffix}] running in ${sandbox.dir}`);
  const run = launchAgent(sandbox, [message, "--resume", sessionId], suffix);
  collectOutputs(sandbox, run, suffix);
  console.log(`[reply${suffix}] ${describeRun(run)}: ${sandbox.dir}`);
}

function createSandbox(name, host) {
  const sandbox = sandboxAt(mkdtempSync(join(tmpdir(), `alignfirst-setup-trial-${name}-`)), host);
  for (const path of [
    sandbox.home,
    sandbox.bin,
    sandbox.project,
    sandbox.out,
    sandbox.claudeConfig,
  ])
    mkdirSync(path);
  copyFileSync(hostCredentials(), join(sandbox.claudeConfig, CREDENTIALS_FILE));
  writeGitConfig(sandbox.home);
  writeNpxShim(sandbox.bin, host);
  return sandbox;
}

function sandboxAt(dir, host) {
  const sandbox = {
    dir,
    home: join(dir, "home"),
    bin: join(dir, "bin"),
    project: join(dir, "project"),
    out: join(dir, "out"),
    claudeConfig: join(dir, "claude-config"),
  };
  return { ...sandbox, env: agentEnvironment(sandbox, host) };
}

function writeGitConfig(home) {
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = Trial User\n\temail = trial@example.com\n[init]\n\tdefaultBranch = main\n",
  );
}

function writeNpxShim(bin, host) {
  const path = join(bin, "npx");
  const userAgent = `npm/${host.npmVersion} node/${process.version}`;
  writeFileSync(
    path,
    `#!/bin/sh
# Maps alignfirst and aligndev to the local build; delegates everything else to the real npx.
index=0
package=
for arg do
  index=$((index + 1))
  case "$arg" in
    -p|--package|--package=*|-c|--call|--call=*) exec ${shellQuote(host.realNpx)} "$@" ;;
    -*) ;;
    *) package=$arg; break ;;
  esac
done
case "$package" in
  alignfirst|alignfirst@*) entry=${shellQuote(LOCAL_BINS.alignfirst)} ;;
  aligndev|aligndev@*) entry=${shellQuote(LOCAL_BINS.aligndev)} ;;
  *) exec ${shellQuote(host.realNpx)} "$@" ;;
esac
shift "$index"
export npm_command=exec
export npm_config_user_agent=${shellQuote(userAgent)}
exec ${shellQuote(process.execPath)} "$entry" "$@"
`,
  );
  chmodSync(path, 0o755);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function agentEnvironment(sandbox, host) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("npm_")) delete env[name];
  }
  for (const name of ASSISTANT_SESSION_VARIABLES) delete env[name];
  delete env.ANTHROPIC_API_KEY;
  // Strip the caller's node_modules/.bin entries, which would expose this repository's binaries.
  const callerPath = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry !== "" && !/node_modules[/\\]\.bin$|node-gyp-bin$/.test(entry));
  return {
    ...env,
    HOME: sandbox.home,
    CLAUDE_CONFIG_DIR: sandbox.claudeConfig,
    PATH: [sandbox.bin, ...callerPath].join(delimiter),
    npm_config_cache: host.npmCache,
  };
}

function buildNodeFixture(sandbox) {
  writeFiles(sandbox.project, {
    "package.json": `${JSON.stringify(
      { name: "trial-app", version: "1.0.0", private: true, type: "module", main: "index.js" },
      undefined,
      2,
    )}\n`,
    "index.js": 'console.log("Hello from trial-app");\n',
    "README.md": "# Trial App\n\nA small Node application.\n",
  });
  commitAll(sandbox, "Initial commit");
}

function buildRecommendationFixture(sandbox) {
  writeFiles(sandbox.project, {
    "AGENTS.md":
      "# Agent Instructions\n\n## Project context\n\nRun `npx alignfirst context` before any task.\n\n## Coding style\n\nUse 2-space indentation.\n",
    "docs/architecture.md": "# Architecture\n\nA web front end calls a REST API.\n",
    "package.json": `${JSON.stringify({ name: "acme-portal", version: "0.3.0", private: true }, undefined, 2)}\n`,
  });
  commitAll(sandbox, "chore: initial structure");
  const features = [
    ["ABC-12", "add login"],
    ["ABC-9", "add user list"],
    ["ABC-13", "fix password reset"],
    ["ABC-11", "add audit log"],
    ["ABC-10", "update dependencies"],
  ];
  for (const [ticket, summary] of features) {
    const type = summary.startsWith("fix") ? "fix" : "feat";
    writeFiles(sandbox.project, { [`src/${ticket.toLowerCase()}.js`]: `// ${summary}\n` });
    commitAll(sandbox, `${type}: [${ticket}] ${summary}`);
  }
  for (const branch of ["ABC-14/session-timeout", "ABC-15/export-csv"]) {
    git(sandbox, ["branch", branch]);
  }
}

function buildPythonFixture(sandbox) {
  writeFiles(sandbox.project, {
    "app.py": `import os
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"Hello from the trial app\\n")


port = int(os.environ.get("PORT", "8000"))
server = HTTPServer(("127.0.0.1", port), Handler)
print(f"listening on {port}", flush=True)
server.serve_forever()
`,
    "README.md":
      "# Trial App\n\nA small Python HTTP server. Run it with `PORT=8000 python3 app.py`.\n",
  });
  commitAll(sandbox, "Initial commit");
}

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function commitAll(sandbox, message) {
  if (!existsSync(join(sandbox.project, ".git"))) git(sandbox, ["init", "--quiet"]);
  git(sandbox, ["add", "--all"]);
  git(sandbox, ["commit", "--quiet", "--message", message]);
}

function git(sandbox, args) {
  const result = spawnSync("git", args, { cwd: sandbox.project, env: sandbox.env });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function launchAgent(sandbox, promptArgs, suffix) {
  const transcript = openSync(join(sandbox.out, `transcript${suffix}.jsonl`), "w");
  const stderr = openSync(join(sandbox.out, `stderr${suffix}.txt`), "w");
  const startedAt = Date.now();
  // Output goes to files, not pipes, so that servers the agent leaves running cannot block the run.
  const result = spawnSync(
    "claude",
    [
      "-p",
      ...promptArgs,
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    {
      cwd: sandbox.project,
      env: sandbox.env,
      stdio: ["ignore", transcript, stderr],
      timeout: RUN_TIMEOUT_MS,
      killSignal: "SIGTERM",
    },
  );
  closeSync(transcript);
  closeSync(stderr);
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error,
    minutes: ((Date.now() - startedAt) / 60_000).toFixed(1),
  };
}

function collectOutputs(sandbox, run, suffix) {
  writeFileSync(join(sandbox.out, `result${suffix}.md`), resultText(sandbox, run, suffix));
  if (existsSync(join(sandbox.project, ".git"))) {
    writeFileSync(join(sandbox.out, "git-status.txt"), gitReport(sandbox));
  }
  writeFileSync(join(sandbox.out, "tree.txt"), treeReport(sandbox));
  writeFileSync(
    join(sandbox.out, "setup.txt"),
    runShim(sandbox, ["-y", "alignfirst", "setup"]).text,
  );
  writeFileSync(
    join(sandbox.out, "doctor.txt"),
    runShim(sandbox, ["-y", "alignfirst", "doctor"]).text,
  );
}

function resultText(sandbox, run, suffix) {
  const result = readTranscript(join(sandbox.out, `transcript${suffix}.jsonl`)).findLast(
    (event) => event.type === "result",
  );
  const header = run.timedOut ? "Timed out after 30 minutes.\n\n" : "";
  return `${header}${result?.result ?? "(no result event in the transcript)"}\n`;
}

function readTranscript(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

function gitReport(sandbox) {
  const options = { cwd: sandbox.project, env: sandbox.env };
  const status = capture("git", ["status", "--short"], options);
  const log = capture("git", ["log", "--oneline", "--all"], options);
  return `# git status --short\n${status}\n# git log --oneline --all\n${log}`;
}

function treeReport(sandbox) {
  const sections = [
    ["project/", sandbox.project],
    ["home/.alignfirst/", join(sandbox.home, ".alignfirst")],
  ];
  return sections
    .map(
      ([label, dir]) =>
        `# ${label}\n${existsSync(dir) ? listTree(dir, "").join("\n") : "(absent)"}\n`,
    )
    .join("\n");
}

function listTree(dir, prefix) {
  const lines = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    const relative = `${prefix}${entry.name}`;
    if (lstatSync(path).isSymbolicLink()) {
      lines.push(`${relative} -> ${readlinkSync(path)}`);
    } else if (entry.isDirectory()) {
      lines.push(`${relative}/`, ...listTree(path, `${relative}/`));
    } else {
      lines.push(relative);
    }
  }
  return lines;
}

function runShim(sandbox, args) {
  const result = spawnSync(join(sandbox.bin, "npx"), args, {
    cwd: sandbox.project,
    env: sandbox.env,
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;
  return { output, text: `${output}\n(exit ${result.status})\n` };
}

function describeRun(run) {
  if (run.timedOut) return `timed out after ${run.minutes} min`;
  if (run.error) return `failed to start: ${run.error.message}`;
  return `exit ${run.status ?? run.signal} after ${run.minutes} min`;
}
