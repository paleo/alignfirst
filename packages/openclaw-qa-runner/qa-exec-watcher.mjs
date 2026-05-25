#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const IPC_DIR = "/var/run/qa-ipc";
const MAX_OUTPUT_BYTES = 1_048_576;
const POLL_INTERVAL_MS = 100;

mkdirSync(IPC_DIR, { recursive: true });

// Sweep stale IPC artifacts left by a killed predecessor in the (named-volume,
// persistent) IPC dir, so the next runner cycle starts clean.
try {
  for (const f of readdirSync(IPC_DIR)) {
    if (f.endsWith(".req.json") || f.endsWith(".req.json.processing") || f.endsWith(".res.json")) {
      try {
        rmSync(`${IPC_DIR}/${f}`, { force: true });
      } catch (err) {
        console.error(`qa-exec-watcher: failed to clean stale IPC file ${f}:`, err);
      }
    }
  }
} catch (err) {
  console.error(`qa-exec-watcher: failed to scan IPC dir ${IPC_DIR}:`, err);
}

async function main() {
  for (;;) {
    let entries;
    try {
      entries = readdirSync(IPC_DIR);
    } catch {
      entries = [];
    }
    const reqFiles = entries.filter((f) => f.endsWith(".req.json"));
    for (const f of reqFiles) {
      const reqPath = `${IPC_DIR}/${f}`;
      const claimed = `${reqPath}.processing`;
      try {
        renameSync(reqPath, claimed);
      } catch {
        continue;
      }
      processRequest(claimed).catch((err) => {
        console.error("qa-exec-watcher: internal error", err);
      });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function processRequest(claimedPath) {
  let id = "unknown";
  try {
    const raw = readFileSync(claimedPath, "utf8");
    const req = JSON.parse(raw);
    id = req.id;
    const result = await runChild(req);
    writeResult(id, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeResult(id, { exitCode: 255, stdout: "", stderr: `watcher error: ${message}` });
  } finally {
    rmSync(claimedPath, { force: true });
  }
}

function runChild(req) {
  const { argv, cwd, env, stdin, timeoutMs = 30_000 } = req;
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutDropped = 0;
    let stderrDropped = 0;
    let killedByTimeout = false;

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      if (stdout.length + s.length > MAX_OUTPUT_BYTES) {
        const room = Math.max(0, MAX_OUTPUT_BYTES - stdout.length);
        stdout += s.slice(0, room);
        stdoutDropped += s.length - room;
      } else {
        stdout += s;
      }
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      if (stderr.length + s.length > MAX_OUTPUT_BYTES) {
        const room = Math.max(0, MAX_OUTPUT_BYTES - stderr.length);
        stderr += s.slice(0, room);
        stderrDropped += s.length - room;
      } else {
        stderr += s;
      }
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 255,
        stdout,
        stderr: `${stderr}\nspawn error: ${err.message}`,
      });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (stdoutDropped > 0) stdout += `\n…[truncated ${stdoutDropped} bytes]`;
      if (stderrDropped > 0) stderr += `\n…[truncated ${stderrDropped} bytes]`;
      if (killedByTimeout) {
        resolve({
          exitCode: 124,
          stdout,
          stderr: `${stderr}\n…[killed by watcher timeout after ${timeoutMs}ms]`,
        });
        return;
      }
      const exitCode = code ?? (signal ? 128 : 1);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function writeResult(id, result) {
  const finalPath = `${IPC_DIR}/${id}.res.json`;
  const tmp = `${finalPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(result));
  renameSync(tmp, finalPath);
}

void main();
