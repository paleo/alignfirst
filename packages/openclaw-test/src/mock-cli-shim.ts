/**
 * Mock-CLI shim. Symlinked from `/opt/qa-mocks/bin/{git,npm,pnpm,yarn,claude}`.
 * Determines its invoked name from argv[1] basename, POSTs the call to the
 * runner's /mock-cli/invoke endpoint, and replays the response locally.
 */

import { basename } from "node:path";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

function die(msg: string, code = 127): never {
  process.stderr.write(`mock-cli shim: ${msg}\n`);
  process.exit(code);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface ShimResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function post(urlStr: string, body: string): Promise<ShimResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error(`runner returned HTTP ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as ShimResponse);
          } catch (err) {
            reject(new Error(`invalid JSON response: ${(err as Error).message}`));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main(): Promise<void> {
  // The sh wrapper at /opt/qa-mocks/bin/mock-cli-shim invokes us as
  //   exec node mock-cli-shim.js "$0" "$@"
  // so argv[2] is the symlink path used to call us (e.g. /opt/qa-mocks/bin/git)
  // and argv.slice(3) is the original argv tail.
  const invokedAs = basename(process.argv[2] ?? "");
  if (!invokedAs) die("could not determine invoked binary name from argv[2]");

  const runnerUrl = process.env.QA_RUNNER_URL;
  if (!runnerUrl) die("QA_RUNNER_URL is not set");

  const stdin = await readStdin();
  const body = JSON.stringify({
    cli: invokedAs,
    argv: process.argv.slice(3),
    cwd: process.cwd(),
    stdin,
  });

  let res: ShimResponse;
  try {
    res = await post(`${runnerUrl}/mock-cli/invoke`, body);
  } catch (err) {
    die(`POST ${runnerUrl}/mock-cli/invoke failed: ${(err as Error).message}`);
  }

  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(typeof res.exitCode === "number" ? res.exitCode : 1);
}

main().catch((err) => die((err as Error).message ?? String(err)));
