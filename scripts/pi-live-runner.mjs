import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
const model = process.env.PI_ACCEPTANCE_MODEL;
const artifacts = process.env.PI_ACCEPTANCE_ARTIFACTS;
const paths = ["pi-subagent", "pi-background"].map((name) =>
  join(root, "node_modules/@alignfirst", name),
);
const outcomes = [];
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const cwd = join(root, "project");
const traces = [];
const cases = { subagents, ordinaryCompletion, aligndev, failureCancellation, cliLifecycle };

mkdirSync(join(cwd, ".plans"), { recursive: true });

try {
  assert(
    process.env.PI_ACCEPTANCE_CASE === undefined ||
      Object.hasOwn(cases, process.env.PI_ACCEPTANCE_CASE),
    "Unknown PI_ACCEPTANCE_CASE; no acceptance was run",
  );
  for (const [name, run] of Object.entries(cases)) {
    if (process.env.PI_ACCEPTANCE_CASE !== undefined && process.env.PI_ACCEPTANCE_CASE !== name)
      continue;
    console.log(`Live Terra case: ${name}`);
    await run();
  }
} finally {
  writeFileSync(
    join(artifacts, "outcomes.json"),
    JSON.stringify(
      { model, pi: "1.3.0", node: process.version, platform: process.platform, outcomes, traces },
      undefined,
      2,
    ),
  );
}

async function subagents() {
  const h = await parent(["subagent"]);
  try {
    for (const input of [
      { task: "Do not use tools. Reply exactly SINGLE-OK." },
      {
        tasks: [
          { task: "Do not use tools. Reply exactly PARALLEL-ONE." },
          { task: "Do not use tools. Reply exactly PARALLEL-TWO." },
        ],
      },
    ]) {
      const result = await h.call("subagent", { ...input, model, thinking: "low" });
      assert.equal(result.isError, false, JSON.stringify(result));
      const expected = input.task !== undefined ? ["SINGLE-OK"] : ["PARALLEL-ONE", "PARALLEL-TWO"];
      assert.deepEqual(
        result.structuredContent.results.map((r) => r.output.trim()),
        expected,
      );
    }
    outcomes.push("packaged live synchronous single and parallel children");
  } finally {
    await h.close();
  }
  const events = [];
  const child = spawn(
    process.execPath,
    [
      cli,
      "--mode",
      "json",
      "--no-session",
      "--no-extensions",
      "-e",
      paths[0],
      "--model",
      model,
      "--thinking",
      "low",
      "--tools",
      "subagent",
      `Call subagent twice sequentially. First input: {"task":"Do not use tools. Reply exactly HEADLESS-SINGLE.","model":"${model}","thinking":"low"}. Second input: {"tasks":[{"task":"Do not use tools. Reply exactly HEADLESS-ONE."},{"task":"Do not use tools. Reply exactly HEADLESS-TWO."}],"model":"${model}","thinking":"low"}. Omit agent to use bundled worker; terra is a model, not an agent profile. After both calls succeed reply exactly HEADLESS-OK. Do not ask interactive questions.`,
    ],
    { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise((resolve) => child.once("close", resolve));
  for (const line of stdout.trim().split("\n")) events.push(JSON.parse(line));
  assert.equal(exit, 0, stderr);
  writeFileSync(
    join(artifacts, "headless-events.json"),
    JSON.stringify(
      events.flatMap((event) =>
        event.type === "tool_execution_start" || event.type === "tool_execution_end"
          ? [event]
          : event.type === "message_end" && event.message.role === "assistant"
            ? [
                {
                  type: event.type,
                  text: text(event.message),
                  stopReason: event.message.stopReason,
                },
              ]
            : [],
      ),
      undefined,
      2,
    ),
  );
  const results = events.filter(
    (e) => e.type === "tool_execution_end" && e.toolName === "subagent",
  );
  assert.equal(results.length, 2);
  assert(
    results.every((result) => result.isError === false),
    JSON.stringify(results),
  );
  assert.deepEqual(
    results[0].result.structuredContent.results.map((r) => r.output.trim()),
    ["HEADLESS-SINGLE"],
  );
  assert.deepEqual(
    results[1].result.structuredContent.results.map((r) => r.output.trim()),
    ["HEADLESS-ONE", "HEADLESS-TWO"],
  );
  assert(
    events.some(
      (e) =>
        e.type === "message_end" &&
        e.message.role === "assistant" &&
        text(e.message).trim() === "HEADLESS-OK",
    ),
  );
  outcomes.push("live headless parent delegates single and parallel packaged subagents");
}

async function ordinaryCompletion() {
  for (const busy of [false, true]) {
    const h = await parent(["background", "bash"]);
    const suffix = busy ? "busy-failure" : "idle-success";
    const exit = busy ? 7 : 0;
    try {
      await h
        .session()
        .prompt(
          `Use background action=start exactly once with command "sleep 12; printf PRIVATE-CHILD-LOG; exit ${exit}" and label "${suffix}". Retain its id. End this turn with exactly ACK-${suffix}. Do not poll or use output. On its later completion, first validate id with background status, then reply exactly DONE-${suffix}. Do not restart a failed job. ${busy ? 'Before ACK, do one foreground bash command "sleep 18"; this deliberately keeps you busy when the job finishes.' : ""}`,
        );
      await waitFor(() => h.finals.some((value) => value.trim() === `DONE-${suffix}`));
      const start = h.events.find(
        (e) =>
          e.type === "tool_execution_end" &&
          e.toolName === "background" &&
          e.result.structuredContent?.action === "start",
      );
      assert(start);
      assert.equal(
        h.events.filter(
          (event) =>
            event.type === "tool_execution_start" &&
            event.toolName === "background" &&
            event.args.action === "start",
        ).length,
        1,
      );
      const job = start.result.structuredContent.job;
      assert.equal(job.status, "running", "Start must return before command completion");
      const acknowledgement = h.events.findIndex(
        (event) =>
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          text(event.message).trim() === `ACK-${suffix}`,
      );
      const completion = h.events.findIndex(
        (event) =>
          event.type === "message_end" &&
          event.message.role === "custom" &&
          event.message.customType === "background-completion",
      );
      assert(
        acknowledgement >= 0 && completion > acknowledgement,
        "Final acknowledgement must precede the later wake turn",
      );
      assert(
        h.events.some(
          (e) =>
            e.type === "tool_execution_start" &&
            e.toolName === "background" &&
            e.args.action === "status" &&
            e.args.id === job.id,
        ),
      );
      assert(h.finals.some((value) => value.trim() === `ACK-${suffix}`));
      assert(!JSON.stringify(h.session().messages).includes("PRIVATE-CHILD-LOG\n"));
      outcomes.push(`${suffix}: acknowledgement then native live completion without user input`);
    } finally {
      await h.close();
    }
  }
}

async function aligndev() {
  const project = join(root, "git-project");
  const worktree = join(root, "git-worktree");
  const git = (...args) =>
    execFileSync("git", args, {
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  git("init", "--quiet", "--initial-branch=main", project);
  git(
    "-C",
    project,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  );
  git("-C", project, "worktree", "add", "--quiet", "-b", "test-worktree", worktree);
  for (const directory of [project, worktree]) mkdirSync(join(directory, ".plans"));
  const h = await parent(["background", "bash"], project);
  const key = `live-${crypto.randomUUID()}`;
  try {
    await h
      .session()
      .prompt(
        `Use background start from ${project} exactly once: aligndev code new --quiet --meta '${key}' -m 'Do not use tools or modify files. Reply exactly LIVE-CODING-RESULT.' Retain the id, key and worktree. Acknowledge with ACK-CODING and end your turn. Do not poll. When its completion arrives validate the handle using background status. Then run aligndev code status --meta '${key}' --result from this worktree using bash. Retain that exact sessionFile path and verify it again with aligndev code status <exact-file> --result. Do not read the transcript. If result is LIVE-CODING-RESULT, run the authorized dependent verification printf FOLLOWUP-OK through bash, then reply exactly CODING-FOLLOWUP-OK. Do not start another coding run.`,
      );
    await waitFor(() => h.finals.some((value) => value.trim() === "CODING-FOLLOWUP-OK"));
    const status = execFileSync("aligndev", ["code", "status", "--meta", key, "--result"], {
      cwd: project,
      encoding: "utf8",
    });
    assert(status.includes("LIVE-CODING-RESULT"));
    assert(!status.includes("[init]"));
    assert(
      h.events.some(
        (e) =>
          e.type === "tool_execution_start" &&
          e.toolName === "background" &&
          e.args.action === "status",
      ),
    );
    outcomes.push(
      "live persistent parent → background → quiet AlignDev Pi child → exact status/result → authorized dependent verification",
    );
  } finally {
    await h.close();
  }
  const h2 = await parent(["background", "bash"], project);
  const slow = `slow-${crypto.randomUUID()}`;
  const fast = `question-${crypto.randomUUID()}`;
  try {
    await h2
      .session()
      .prompt(
        `Start two background jobs, retaining distinct handles and meta keys. First from ${project}: aligndev code new --quiet --meta '${slow}' -m 'Run bash sleep 20, then reply exactly SLOW-RESULT.' Second from ${worktree}: aligndev code new --quiet --meta '${fast}' -m 'Do not use tools. Ask the parent exactly: Which fixture option should I choose?' Acknowledge ACK-TWO and end the turn. No polling. On each completion validate its background status and retrieve aligndev code status --meta <its-key> --result from its original worktree, retaining the exact path. Relay the final question as a question; do not answer it or start another coding run. Report SLOW-RECEIVED when the slow result arrives.`,
      );
    await waitFor(() => h2.finals.some((value) => value.includes("SLOW-RECEIVED")));
    assert(h2.finals.some((value) => value.includes("Which fixture option should I choose?")));
    const completions = h2.events.filter(
      (e) =>
        e.type === "message_end" &&
        e.message.role === "custom" &&
        e.message.customType === "background-completion",
    );
    assert.equal(completions.length, 2);
    const firstNotice = JSON.parse(String(completions[0].message.content).split("\n").at(-1));
    assert.equal(
      firstNotice.jobs[0].cwd,
      worktree,
      "The second-launched workspace must finish first",
    );
    const starts = h2.events.filter(
      (event) =>
        event.type === "tool_execution_start" &&
        event.toolName === "background" &&
        event.args.action === "start",
    );
    assert.equal(starts.length, 2, "A final question must not start an unauthorized coding retry");
    const a = execFileSync("aligndev", ["code", "status", "--meta", slow, "--result"], {
      cwd: project,
      encoding: "utf8",
    });
    const b = execFileSync("aligndev", ["code", "status", "--meta", fast, "--result"], {
      cwd: worktree,
      encoding: "utf8",
    });
    assert(a.includes("SLOW-RESULT"));
    assert(b.includes("Which fixture option should I choose?"));
    outcomes.push("live separate worktrees retain exact results and relay child final question");
  } finally {
    await h2.close();
  }
}

async function failureCancellation() {
  const missing = join(root, "missing-credentials");
  mkdirSync(missing);
  for (const mode of ["auth", "cancel"]) {
    const h = await parent(["background", "bash"]);
    const key = `${mode}-${crypto.randomUUID()}`;
    try {
      const command =
        mode === "auth"
          ? `PI_CODING_AGENT_DIR='${missing}' aligndev code new --quiet --meta '${key}' -m 'Reply AUTH-MUST-NOT-SUCCEED.'`
          : `aligndev code new --quiet --meta '${key}' -m 'Run bash sleep 60 before replying CANCEL-MUST-NOT-COMPLETE.'`;
      await h
        .session()
        .prompt(
          `Start exactly one background coding job from this worktree with command ${JSON.stringify(command)}. Retain id/key. ${mode === "cancel" ? `After the start returns run bash sleep 5 so the CLI can initialize, then cancel through background stop. Retrieve its result with aligndev code status --meta ${key} --result and reply exactly CANCEL-REPORTED.` : `End the launch turn with AUTH-ACK. On completion validate background status, retrieve aligndev code status --meta ${key} --result, then reply exactly AUTH-REPORTED.`} Do not restart or retry coding. Do not inspect or change credentials.`,
        );
      await waitFor(() =>
        h.finals.some((value) => value.trim() === `${mode.toUpperCase()}-REPORTED`),
      );
      const starts = h.events.filter(
        (event) =>
          event.type === "tool_execution_start" &&
          event.toolName === "background" &&
          event.args.action === "start",
      );
      assert.equal(starts.length, 1, "Failure/cancellation must not start a coding retry");
      const status = execFileSync("aligndev", ["code", "status", "--meta", key, "--result"], {
        cwd,
        encoding: "utf8",
      });
      assert(status.includes(`exitReason: ${mode === "auth" ? "auth_required" : "terminated"}`));
      outcomes.push(`live ${mode} reported without coding retry`);
    } finally {
      await h.close();
    }
  }
}

async function cliLifecycle() {
  assert.equal(
    process.platform,
    "linux",
    "The terminal lifecycle probe currently requires Linux and Python 3",
  );
  for (const operation of ["quit", "reload"]) {
    const pidfile = join(root, `${operation}.pid`);
    const evidence = join(artifacts, `tui-${operation}.json`);
    const sessionId = `c6-${operation}`;
    const command = `exec '${process.execPath}' -e 'require("fs").writeFileSync(${JSON.stringify(pidfile)},String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'`;
    const config = join(root, `tui-${operation}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        argv: [
          process.execPath,
          cli,
          "--tui-mode",
          "regular",
          "--model",
          model,
          "--thinking",
          "low",
          "--tools",
          "background",
          "--session-id",
          sessionId,
        ],
        operation,
        pidfile,
        sessionId,
        evidence,
        sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
        prompt: `Use background start exactly once with command ${JSON.stringify(command)}. Reply exactly CLI-ACK. Do not stop it.`,
      }),
    );
    execFileSync("python3", [join(root, "pi-live-tui.py"), config], {
      cwd,
      env: process.env,
      stdio: "inherit",
      timeout: 200000,
    });
    assert.equal(JSON.parse(readFileSync(evidence, "utf8")).fixtureGone, true);
    outcomes.push(`real Pi TUI ${operation} reaps active live-model-launched job`);
  }
}

async function parent(tools, directory = cwd) {
  const events = [];
  const finals = [];
  const runtime = await createAgentSessionRuntime(
    async ({ cwd: target, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd: target,
        agentDir,
        settingsManager: SettingsManager.create(target, agentDir),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noThemes: true,
          noPromptTemplates: true,
          additionalExtensionPaths: paths,
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
    { cwd: directory, agentDir, sessionManager: SessionManager.inMemory(directory) },
  );
  assert.equal(
    `${runtime.session.model?.provider}/${runtime.session.model?.id}`,
    model,
    "No provider/model fallback is authorized",
  );
  await runtime.session.bindExtensions({
    mode: "json",
    onError: (error) => {
      throw new Error(JSON.stringify(error));
    },
  });
  runtime.session.subscribe((event) => {
    events.push(event);
    if (event.type === "message_end" && event.message.role === "assistant") {
      const value = text(event.message);
      if (event.message.stopReason === "stop") finals.push(value);
      traces.push({
        event: "assistant-final",
        text: value,
        stopReason: event.message.stopReason,
        model: `${event.message.provider}/${event.message.model}`,
        error: event.message.errorMessage,
        at: Date.now(),
      });
    } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      traces.push({
        event: event.type,
        tool: event.toolName,
        action: event.args?.action,
        arguments: event.type === "tool_execution_start" ? event.args : undefined,
        resultText:
          event.type === "tool_execution_end" && event.toolName === "bash"
            ? event.result.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n")
            : undefined,
        outcome: event.result?.structuredContent?.job,
        isError: event.isError,
        at: Date.now(),
      });
    } else if (event.type === "message_end" && event.message.role === "custom")
      traces.push({ event: "custom", content: event.message.content, at: Date.now() });
  });
  runtime.session.subscribe(() =>
    writeFileSync(join(artifacts, "parent-trace.json"), JSON.stringify(traces, undefined, 2)),
  );
  return {
    session: () => runtime.session,
    events,
    finals,
    async call(name, input) {
      const tool = runtime.session.agent.state.tools.find((tool) => tool.name === name);
      assert(tool);
      return tool.execute("live", input);
    },
    close: () => runtime.dispose(),
  };
}

function text(message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function waitFor(check) {
  const deadline = Date.now() + 180000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Live acceptance watchdog expired; missing required observation");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
