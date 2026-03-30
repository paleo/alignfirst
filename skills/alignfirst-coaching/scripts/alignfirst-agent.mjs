#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// --- CLI argument parsing ---

const { values } = parseArgs({
  options: {
    new: { type: "boolean", default: false },
    resume: { type: "string" },
    ticket: { type: "string" },
    spec: { type: "boolean", default: false },
    message: { type: "string" },
    plan: { type: "boolean", default: false },
    description: { type: "boolean", default: false },
    aad: { type: "boolean", default: false },
    model: { type: "string" },
  },
  strict: true,
});

const isNew = values.new;
const sessionId = values.resume;
const isResume = sessionId !== undefined;

// --- Validation ---

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (isNew && isResume) fail("Error: --new and --resume are mutually exclusive.");
if (!isNew && !isResume) fail("Error: at least one of --new or --resume is required.");

const modeFlags = [values.spec, values.plan, values.description, values.aad].filter(Boolean);
if (modeFlags.length === 0) fail("Error: one of --spec, --plan, --description, or --aad is required.");
if (modeFlags.length > 1) fail("Error: --spec, --plan, --description, and --aad are mutually exclusive.");

if (values.spec) {
  if (!isNew) fail("Error: --spec requires --new.");
  if (!values.ticket) fail("Error: --spec requires --ticket.");
  if (!values.message) fail("Error: --spec requires --message.");
}
if (values.aad) {
  if (!values.message) fail("Error: --aad requires --message.");
  if (isNew && !values.ticket) fail("Error: --aad with --new requires --ticket.");
}
if (values.description) {
  if (!isNew) fail("Error: --description requires --new.");
  if (!values.ticket) fail("Error: --description requires --ticket.");
}
if (values.plan) {
  if (!isResume) fail("Error: --plan requires --resume.");
}
if (values.ticket !== undefined && !isNew) {
  fail("Error: --ticket is only valid with --new.");
}

// --- Build prompt ---

let prompt;

if (values.spec) {
  prompt = `/alspec Ticket ID = ${values.ticket}\n\n${values.message}`;
} else if (values.aad) {
  const prefix = isNew ? `/al Ticket ID = ${values.ticket}` : `/al`;
  prompt = `${prefix}\n\n${values.message}`;
} else if (values.plan) {
  prompt = values.message ? `/alplan\n\n${values.message}` : `/alplan`;
} else if (values.description) {
  prompt = values.message ? `/aldescription\n\n${values.message}` : `/aldescription`;
} else {
  fail("Error: invalid argument combination.");
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
