import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "./agents.js";
import { bounded, createJsonOutput, type ParsedOutput } from "./json-output.js";
import { launchManaged, type ManagedProcess, type ProcessExit } from "./process-tree.js";

const SESSION_METADATA = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
];

export interface PiAssignment {
  profile: AgentProfile;
  task: string;
  cwd: string;
  model?: string;
  thinking?: string;
}

export interface PiProcessOptions {
  signal: AbortSignal;
  active: () => boolean;
  own: (process: ManagedProcess) => void;
  release: (process: ManagedProcess) => void;
  invocation?: () => Promise<PiInvocation>;
  deadline?: () => number | undefined;
}

export interface PiInvocation {
  command: string;
  args: string[];
}

export interface PiOutcome extends ParsedOutput {
  status: "succeeded" | "failed" | "cancelled";
  exitCode?: number;
  signal?: string;
}

export async function runPi(
  assignment: PiAssignment,
  options: PiProcessOptions,
): Promise<PiOutcome> {
  const output = createJsonOutput();
  const diagnosticDecoder = new StringDecoder("utf8");
  let stderr = "";
  let inputError: string | undefined;
  let cleanupError: string | undefined;
  let managed: ManagedProcess | undefined;
  let directory: string | undefined;
  let stopping: Promise<void> | undefined;
  let stopped!: () => void;
  const stopFinished = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const stop = () => {
    if (!managed || stopping) return;
    stopping = managed
      .stop(options.deadline?.())
      .catch((error: unknown) => {
        cleanupError = `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(stopped);
  };
  const onInputError = (error: Error) => {
    inputError = `Process I/O error: ${error.message}`;
    stop();
  };
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    const invocation = await (options.invocation ?? resolvePiInvocation)();
    directory = await mkdtemp(join(tmpdir(), "pi-subagent-prompt-"));
    const prompt = join(directory, "profile.md");
    await writeFile(prompt, assignment.profile.prompt, { mode: 0o600 });
    const args = [
      ...invocation.args,
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--append-system-prompt",
      prompt,
    ];
    if (assignment.model !== undefined) args.push("--model", assignment.model);
    if (assignment.thinking !== undefined) args.push("--thinking", assignment.thinking);
    if (assignment.profile.tools !== undefined) {
      // Pi keeps callable MCP tools unless explicitly excluded, even with --tools.
      args.push("--tools", assignment.profile.tools.join(","));
      if (!assignment.profile.tools.some((tool) => tool.startsWith("mcp__"))) {
        args.push("--exclude-tools", "mcp__*");
      }
    }
    if (options.signal.aborted || !options.active()) return cancelled(output.assess());
    managed = launchManaged({
      command: invocation.command,
      args,
      cwd: assignment.cwd,
      env: childEnv(),
      stdout(chunk) {
        output.feed(chunk);
        if (output.protocolError !== undefined) stop();
      },
      stderr(chunk) {
        stderr = bounded(stderr + diagnosticDecoder.write(chunk), 4 * 1024).text;
      },
      inputError: onInputError,
    });
    options.own(managed);
    const spawnError = await managed.spawned;
    if (spawnError !== undefined) throw spawnError;
    if (options.signal.aborted || !options.active()) stop();
    // Pi trims piped stdin. The fixed footer keeps assignment trailing whitespace inside the envelope.
    if (stopping === undefined)
      managed.child.stdin.end(`Task:\n${assignment.task}\nEnd of task.`, "utf8");
    await Promise.race([managed.exited, stopFinished]);
    if (stopping === undefined) stop();
    await stopping;
    output.end();
    stderr = bounded(stderr + diagnosticDecoder.end(), 4 * 1024).text;
    const parsed = output.assess();
    const exit = terminalState(managed);
    const error =
      cleanupError ??
      inputError ??
      parsed.error ??
      (exit.code !== 0
        ? `Pi exited with ${exit.signal ?? exit.code ?? "unknown status"}.`
        : undefined);
    if (cleanupError === undefined) options.release(managed);
    const status =
      options.signal.aborted || !options.active()
        ? "cancelled"
        : error === undefined
          ? "succeeded"
          : "failed";
    return {
      ...parsed,
      status,
      exitCode: exit.code ?? undefined,
      signal: exit.signal ?? undefined,
      error:
        error === undefined
          ? undefined
          : bounded(`${error}${stderr === "" ? "" : `\n${stderr}`}`, 4 * 1024).text,
    };
  } catch (error) {
    if (managed) {
      stop();
      await stopping;
      if (cleanupError === undefined) options.release(managed);
    }
    const diagnostic = `${cleanupError ?? (error instanceof Error ? error.message : String(error))}\n${stderr}`;
    return {
      ...output.assess(),
      status: options.signal.aborted || !options.active() ? "cancelled" : "failed",
      error: bounded(diagnostic, 4 * 1024).text,
    };
  } finally {
    options.signal.removeEventListener("abort", stop);
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}

function cancelled(parsed: ParsedOutput): PiOutcome {
  return { ...parsed, status: "cancelled", error: "Subagent cancelled before launch." };
}

function terminalState(managed: ManagedProcess): ProcessExit {
  return { code: managed.child.exitCode, signal: managed.child.signalCode };
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of SESSION_METADATA) delete env[name];
  return env;
}

async function resolvePiInvocation(): Promise<PiInvocation> {
  // A host package's declared bin is authority; an arbitrary SDK argv[1] is not.
  const root = getPackageDir();
  const value: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    value.name !== "@earendil-works/pi-coding-agent" ||
    !("bin" in value) ||
    typeof value.bin !== "object" ||
    value.bin === null ||
    !("pi" in value.bin) ||
    typeof value.bin.pi !== "string"
  )
    throw new Error("No supported installed Pi package CLI is available.");
  const cli = resolve(root, value.bin.pi);
  if (!cli.startsWith(`${resolve(root)}/`) || !existsSync(cli))
    throw new Error("Installed Pi CLI entry is missing.");
  const runtime = /^(node|bun)(\.exe)?$/i.test(basename(process.execPath))
    ? process.execPath
    : "node";
  return { command: runtime, args: [cli] };
}
