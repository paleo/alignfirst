import { renameSync, writeFileSync } from "node:fs";

if (process.argv.includes("--epipe")) {
  process.stdin.destroy();
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const capture = {
    runtime: process.execPath,
    input,
    env: Object.fromEntries(
      [
        "PI_SESSION_ID",
        "PI_SESSION_FILE",
        "PI_PROVIDER",
        "PI_MODEL",
        "PI_REASONING_LEVEL",
        "PI_OFFLINE",
        "SUBAGENT_TEST_CREDENTIAL",
      ].map((key) => [key, process.env[key]]),
    ),
  };
  // Readers count "capture-" files, so the temp name must not match until the content is complete.
  writeFileSync(`.capture-${process.pid}.json.tmp`, JSON.stringify(capture));
  renameSync(`.capture-${process.pid}.json.tmp`, `capture-${process.pid}.json`);
  const task = input.slice("Task:\n".length, -"\nEnd of task.".length);
  if (task === "startup-error") {
    process.stderr.write("No API key found for fixture.\n");
    process.exit(1);
  }
  if (task === "signal") {
    process.kill(process.pid, "SIGTERM");
    return;
  }
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  emit({
    type: "session",
    version: 3,
    id: `fixture-${process.pid}`,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
  });
  if (task.startsWith("wait")) {
    setInterval(() => {}, 1000);
    return;
  }
  const message = {
    role: "assistant",
    timestamp: 1,
    provider: "fixture",
    model: "local",
    content: [{ type: "text", text: task }],
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  };
  emit({ type: "message_end", message });
  emit({ type: "agent_settled", aborted: false });
});
