#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// --- CLI argument parsing ---

const PROTOCOLS = ["spec", "plan", "aad", "description", "read", "review", "merge"];

const { values } = parseArgs({
  options: {
    new: { type: "boolean", default: false },
    resume: { type: "string" },
    ticket: { type: "string" },
    protocol: { type: "string" },
    message: { type: "string" },
    model: { type: "string" },
  },
  strict: true,
});

const isNew = values.new;
const sessionId = values.resume;
const isResume = sessionId !== undefined;
const protocol = values.protocol;

// --- Validation ---

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (isNew && isResume) fail("Error: --new and --resume are mutually exclusive.");
if (!isNew && !isResume) fail("Error: at least one of --new or --resume is required.");

if (protocol !== undefined && !PROTOCOLS.includes(protocol)) {
  fail(`Error: --protocol must be one of: ${PROTOCOLS.join(", ")}.`);
}

if (!protocol && !values.message) {
  fail("Error: --message is required when --protocol is not specified.");
}

if (isNew && protocol && !values.ticket) {
  fail("Error: --ticket is required with --new and --protocol.");
}

if (["spec", "aad"].includes(protocol) && !values.message) {
  fail(`Error: --protocol ${protocol} requires --message.`);
}

if (values.ticket !== undefined && !isNew) {
  fail("Error: --ticket is only valid with --new.");
}

// --- Build prompt ---

const PROTOCOL_LABELS = {
  spec: "spec",
  aad: "AAD",
  plan: "plan",
  description: "description",
  review: "review",
  merge: "merge",
};

function buildProtocolPrompt(label, ticket, message) {
  const ticketPart = ticket ? ` Ticket ID = ${ticket}.` : "";
  const messagePart = message ? `\n\n${message}` : "";
  return `Run the _${label}_ protocol from the *alignfirst* skill.${ticketPart}${messagePart}`;
}

let prompt;

if (!protocol) {
  // No protocol: just send the message as-is
  prompt = values.message;
} else if (protocol === "read") {
  const ticketPart = values.ticket ? ` for ticket ${values.ticket}` : "";
  const messagePart = values.message ? `\n\n${values.message}` : "";
  prompt = `Use the *alignfirst* skill to determine the TASK_DIR${ticketPart}. Then read every \`*spec.md\` and \`*summary.md\` file in the TASK_DIR.${messagePart}`;
} else {
  prompt = buildProtocolPrompt(PROTOCOL_LABELS[protocol], values.ticket, values.message);
}

// --- Log file (inputs) ---

const logDir = process.env.ALIGNFIRST_AGENT_LOG_DIR;
let logPath;
if (logDir) {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const timestamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const rand = Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const filename = `${timestamp}-${rand}.md`;
  logPath = join(logDir, filename);

  const presentOptions = Object.entries(values)
    .filter(([k, v]) => v !== undefined && v !== false && k !== "message")
    .map(([k, v]) => (v === true ? `  --${k}` : `  --${k} ${JSON.stringify(v)}`))
    .join("\n");

  const logHeader = [
    `Date: ${now.toISOString()}`,
    `Options:\n${presentOptions}`,
  ];

  if (values.message) {
    logHeader.push(`\n${values.message}`);
  }

  mkdirSync(logDir, { recursive: true });
  writeFileSync(logPath, `---- Inputs ----\n\n${logHeader.join("\n")}\n`);
}

function logErrorAndExit(msg, logMsg = msg) {
  console.error(msg);
  if (logPath) {
    appendFileSync(logPath, `\n---- Error ----\n\n${logMsg}\n`);
    const errorPath = logPath.replace(/\.md$/, "-ERROR.md");
    renameSync(logPath, errorPath);
  }
  process.exit(1);
}

// --- Spawn claude ---

const args = [prompt, "-p", "--output-format", "json"];

if (process.env.ALIGNFIRST_AGENT_SKIP_PERMISSIONS === "1") {
  args.push("--dangerously-skip-permissions");
} else {
  args.push("--permission-mode", "auto");
}

if (isResume) {
  args.push("--resume", sessionId);
}
if (values.model) {
  args.push("--model", values.model);
}

const result = spawnSync("claude", args, {
  encoding: "utf-8",
  maxBuffer: 50 * 1024 * 1024,
});

if (result.status !== 0) {
  logErrorAndExit(result.stderr || `claude exited with code ${result.status}`);
}

// --- Parse output ---

let parsed;
try {
  parsed = JSON.parse(result.stdout);
} catch {
  logErrorAndExit("Failed to parse JSON output from claude:\n" + result.stdout);
}

function formatParsedLog(obj) {
  const meta = Object.entries(obj)
    .filter(([k]) => k !== "result")
    .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `${meta}\n\n${obj.result}\n`;
}

if (parsed.is_error) {
  logErrorAndExit(parsed.result, logPath ? formatParsedLog(parsed) : undefined);
}

if (logPath) {
  appendFileSync(logPath, `\n---- Output ----\n\n${formatParsedLog(parsed)}`);
}

// --- Output ---

const output = isNew ? `Session ID: ${parsed.session_id}\n\n${parsed.result}` : parsed.result;

console.log(output);
