import { readFileSync, writeFileSync } from "node:fs";

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
  const promptIndex = process.argv.indexOf("--append-system-prompt");
  const capture = {
    input,
    args: process.argv.slice(2),
    cwd: process.cwd(),
    profile: promptIndex === -1 ? undefined : readFileSync(process.argv[promptIndex + 1], "utf8"),
    promptPath: process.argv[promptIndex + 1],
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
  writeFileSync(`capture-${process.pid}.json`, JSON.stringify(capture));
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
  if (task === "malformed") {
    process.stdout.write("{bad}\n");
    return;
  }
  if (task === "incomplete") return;
  if (task.startsWith("wait")) {
    setInterval(() => {}, 1000);
    return;
  }
  const output = task === "large" ? "😀".repeat(20_000) : task;
  const message = {
    role: "assistant",
    timestamp: 1,
    provider: "fixture",
    model: "local",
    content: [{ type: "text", text: output }],
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: task === "error" ? "error" : task === "length" ? "length" : "stop",
  };
  emit({ type: "message_end", message });
  emit({ type: "agent_settled", aborted: false });
});
