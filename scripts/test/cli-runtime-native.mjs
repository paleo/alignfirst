#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

const runtime = process.versions.bun === undefined ? "node" : "bun";
const executable = basename(process.argv[1]);
appendFileSync(
  process.env.CLI_NATIVE_LOG,
  `${JSON.stringify({ executable, runtime, args: process.argv.slice(2) })}\n`,
);
assert.equal(runtime, process.env.CLI_NATIVE_EXPECT ?? "node", "external native runtime");

if (process.argv[2] === "debug") {
  console.log(JSON.stringify({ models: [{ slug: "gpt-9-sol" }] }));
} else if (process.argv[2] === "app-server") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") console.log(JSON.stringify({ id: 0, result: {} }));
    if (message.method === "account/rateLimits/read") {
      console.log(
        JSON.stringify({
          id: 1,
          result: { rateLimits: { primary: { usedPercent: 15, windowDurationMins: 300 } } },
        }),
      );
    }
  });
} else if (process.argv.includes("/usage")) {
  console.log(JSON.stringify({ subtype: "success", result: "Current session: 25% used" }));
} else {
  for await (const _chunk of process.stdin) {
    // Consume the real delegation prompt before reporting a complete native turn.
  }
  if (executable === "codex") {
    for (const event of [
      { type: "thread.started", thread_id: "offline-codex" },
      { type: "item.completed", item: { type: "agent_message", text: "native complete" } },
      { type: "turn.completed" },
    ])
      console.log(JSON.stringify(event));
  } else {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "offline-native" }));
    console.log(
      JSON.stringify({ type: "result", session_id: "offline-native", result: "native complete" }),
    );
  }
}
