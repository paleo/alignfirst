import { writeFileSync } from "node:fs";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(process.env.CLI_RUNTIME_PROMPT, prompt);
if (process.env.FAKE_AGENT_MODE === "failure") {
  console.error("offline agent failure");
  process.exit(7);
}
if (process.env.FAKE_AGENT_MODE === "resistant") {
  process.on("SIGTERM", () => {});
  writeFileSync(process.env.CLI_RUNTIME_AGENT_PID, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "offline-session" }));
  process.stdout.write(
    JSON.stringify({
      type: "result",
      session_id: "offline-session",
      result: "offline complete",
      is_error: false,
    }),
  );
}
