import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const match = /CASE:(\w+):([^\s]+)/.exec(prompt);
if (!match) throw new Error("Missing integration assignment");
const [, mode, gate] = match;
writeFileSync(`${gate}.pid`, String(process.pid));
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const assistant = (text, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason,
  timestamp: Date.now(),
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
emit({
  type: "session",
  version: 3,
  id: randomUUID(),
  cwd: process.cwd(),
  timestamp: new Date().toISOString(),
});
emit({ type: "message_end", message: assistant("PRIVATE-INTERNAL-TRANSCRIPT", "toolUse") });
if (mode === "cancel") process.on("SIGTERM", () => {});
while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 10));
if (mode === "auth") {
  process.stderr.write("No API key found for integration-fixture.\n");
  process.exitCode = 1;
} else {
  emit({
    type: "message_end",
    message: assistant(
      mode === "failure" ? "fixture failure" : `FINAL:${mode}`,
      mode === "failure" ? "error" : "stop",
    ),
  });
  emit({ type: "agent_settled", aborted: false });
}
