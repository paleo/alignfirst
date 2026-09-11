import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const LOG_DIRECTORY = "/tmp/openclaw";

main();

function main() {
  const [sessionKey, since] = process.argv.slice(2);
  if (sessionKey === undefined || since === undefined)
    throw new Error("session key and epoch required");
  const database = new DatabaseSync(
    "/home/claw/.openclaw/agents/main/agent/openclaw-agent.sqlite",
    { readOnly: true },
  );
  try {
    const rows = database
      .prepare(`
      SELECT e.event_json FROM transcript_events e
      JOIN session_windows w ON w.session_id = e.session_id
      WHERE w.session_key = ? AND e.created_at >= ?
      ORDER BY e.created_at, e.seq
    `)
      .all(sessionKey, Number(since));
    const messages = rows.map((row) => JSON.parse(row.event_json).message).filter(Boolean);
    const assistants = messages.filter((message) => message.role === "assistant");
    const terminals = assistants
      .filter((message) => message.stopReason === "stop")
      .map((message) =>
        message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      );
    const toolNames = assistants.flatMap((message) =>
      message.content.filter((block) => block.type === "toolCall").map((block) => block.name),
    );
    const logFiles = readdirSync(LOG_DIRECTORY).filter((name) => /^openclaw-.*\.log$/u.test(name));
    if (logFiles.length === 0) throw new Error("Gateway log files are missing");
    const finalizations = logFiles.reduce((count, name) => {
      const log = readFileSync(`${LOG_DIRECTORY}/${name}`, "utf8");
      return count + [...log.matchAll(/running isolated finalization/gu)].length;
    }, 0);
    const lastMessage = messages.at(-1);
    const openTurn =
      lastMessage?.role === "user" ||
      lastMessage?.role === "toolResult" ||
      (lastMessage?.role === "assistant" && lastMessage.stopReason === "toolUse");
    process.stdout.write(
      JSON.stringify({
        terminals,
        toolNames,
        finalizations,
        messageCount: messages.length,
        openTurn,
        observedAt: Date.now(),
      }),
    );
  } finally {
    database.close();
  }
}
