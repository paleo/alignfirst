import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createOutputBuffer, type OutputBuffer, preview } from "./output-buffer.js";
import {
  type LaunchOptions,
  launchManaged,
  type ManagedProcess,
  type ProcessExit,
} from "./process-tree.js";

export interface JobRegistry {
  origin: Origin;
  active: () => boolean;
  start: (input: StartInput, launch: LaunchContext, signal?: AbortSignal) => Promise<JobMetadata>;
  list: () => JobMetadata[];
  get: (id: string) => Job;
  stop: (id: string) => Promise<JobMetadata>;
  clear: (id: string) => void;
  retire: () => Promise<void>;
}

export interface Origin {
  sessionId: string;
  runtimeId: string;
  generation: number;
}

export interface JobMetadata {
  id: string;
  command: string;
  cwd: string;
  label?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  signal?: string;
  error?: string;
  outputBytes: number;
  retainedBytes: number;
  truncated: boolean;
}

export interface Job {
  id: string;
  command: string;
  cwd: string;
  label?: string;
  startedAt: string;
  finishedAt?: string;
  status: JobMetadata["status"];
  error?: string;
  ioError?: string;
  process?: ManagedProcess;
  output: OutputBuffer;
  accepted: boolean;
  cancelled: boolean;
  sendAttempted: boolean;
  noticePending: boolean;
  exit?: ProcessExit;
  cleanup?: Promise<void>;
}

export interface StartInput {
  command: string;
  cwd?: string;
  label?: string;
}

export interface LaunchContext {
  cwd: string;
  shell: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface RegistryOptions {
  origin: Origin;
  completed: (job: Job) => void;
  launch?: (options: LaunchOptions) => ManagedProcess;
  beforeAcknowledge?: () => Promise<void>;
}

export function createRegistry(options: RegistryOptions): JobRegistry {
  const jobs = new Map<string, Job>();
  const starts = new Set<Promise<JobMetadata>>();
  let active = true;
  const check = () => {
    if (!active) throw new Error("Background owner retired; this handle is no longer valid.");
  };
  const get = (id: string) => {
    check();
    const job = jobs.get(id);
    if (!job?.accepted) throw new Error("Unknown, cleared, foreign, or retired background handle.");
    return job;
  };
  const finish = (job: Job) => finishJob(job, () => active, options.completed);
  return {
    origin: options.origin,
    active: () => active,
    start(input, launch, signal) {
      check();
      if ([...jobs.values()].filter((job) => job.status === "running").length >= 8) {
        throw new Error("Eight background jobs are live. Stop a job before starting another.");
      }
      if (jobs.size >= 32) {
        throw new Error(
          "32 background records retained. Clear a terminal job before starting another.",
        );
      }
      const job: Job = {
        id: randomUUID(),
        command: input.command,
        cwd: resolve(launch.cwd, input.cwd ?? "."),
        label: input.label,
        startedAt: new Date().toISOString(),
        status: "running",
        output: createOutputBuffer(),
        accepted: false,
        cancelled: false,
        sendAttempted: false,
        noticePending: false,
      };
      jobs.set(job.id, job);
      const pending = startJob(job, launch, signal, options, check, finish, jobs);
      starts.add(pending);
      void pending.finally(() => starts.delete(pending)).catch(() => {});
      return pending;
    },
    list() {
      check();
      return [...jobs.values()].filter((job) => job.accepted).map(jobMetadata);
    },
    get,
    async stop(id) {
      const job = get(id);
      if (job.status !== "running") return jobMetadata(job);
      job.cancelled = true;
      job.noticePending = false;
      await finish(job);
      check();
      return jobMetadata(job);
    },
    clear(id) {
      const job = get(id);
      if (job.status === "running")
        throw new Error("Only terminal background jobs can be cleared.");
      job.noticePending = false;
      jobs.delete(id);
    },
    async retire() {
      active = false;
      for (const job of jobs.values()) {
        job.cancelled = true;
        job.noticePending = false;
      }
      const results = await Promise.allSettled([
        ...[...jobs.values()].filter((job) => job.process !== undefined).map(finish),
        ...starts,
      ]);
      const failures = results.filter((result) => result.status === "rejected");
      const unresolved = [...jobs.values()].filter(
        (job) => job.status === "running" && job.process,
      );
      if (unresolved.length > 0) {
        throw new AggregateError(
          failures,
          "Background cleanup failed; unresolved process ownership retained.",
        );
      }
      jobs.clear();
    },
  };
}

async function startJob(
  job: Job,
  launch: LaunchContext,
  signal: AbortSignal | undefined,
  options: RegistryOptions,
  check: () => void,
  finish: (job: Job) => Promise<void>,
  jobs: Map<string, Job>,
): Promise<JobMetadata> {
  const abort = () => {
    job.cancelled = true;
    job.noticePending = false;
    if (job.process) void finish(job).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (!(await stat(job.cwd)).isDirectory())
      throw new Error("Background cwd must be a directory.");
    check();
    if (job.cancelled) throw new Error("Background launch cancelled before acknowledgement.");
    job.process = (options.launch ?? launchManaged)({
      command: launch.shell,
      args: [...launch.args, job.command],
      cwd: job.cwd,
      env: launch.env,
      stdout: (chunk) => job.output.append("stdout", chunk),
      stderr: (chunk) => job.output.append("stderr", chunk),
      inputError: (error) => {
        job.ioError = preview(error.message, 512);
        job.error = job.ioError;
      },
    });
    job.process.child.stdin.end();
    void job.process.exited
      .then((exit) => {
        job.exit = exit;
        return finish(job);
      })
      .catch(() => {});
    const error = await job.process.spawned;
    if (error) throw error;
    await options.beforeAcknowledge?.();
    check();
    if (job.cancelled || signal?.aborted)
      throw new Error("Background launch cancelled before acknowledgement.");
    job.accepted = true;
    signal?.removeEventListener("abort", abort);
    if (job.status !== "running" && !job.cancelled) options.completed(job);
    return jobMetadata(job);
  } catch (error) {
    abort();
    if (job.process) {
      try {
        await finish(job);
      } catch (cleanupError) {
        job.accepted = true;
        throw new Error(
          `Background launch cleanup incomplete; retained handle ${job.id}: ${preview(cleanupError instanceof Error ? cleanupError.message : String(cleanupError), 512)}`,
        );
      }
    }
    if (job.status !== "running" || !job.process) jobs.delete(job.id);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function finishJob(
  job: Job,
  active: () => boolean,
  completed: (job: Job) => void,
): Promise<void> {
  if (job.cleanup) return job.cleanup;
  if (job.status !== "running" || !job.process) return;
  const managed = job.process;
  job.cleanup = (async () => {
    try {
      await managed.stop();
      job.exit = await managed.exited;
      job.output.finish();
      job.finishedAt = new Date().toISOString();
      job.error = job.exit.error === undefined ? job.ioError : preview(job.exit.error.message, 512);
      job.status = job.cancelled
        ? "cancelled"
        : job.exit.code === 0 && job.error === undefined
          ? "succeeded"
          : "failed";
      if (active() && job.accepted && !job.cancelled) completed(job);
    } catch (error) {
      job.error = `Cleanup incomplete: ${preview(error instanceof Error ? error.message : String(error), 512)}`;
      throw error;
    } finally {
      job.cleanup = undefined;
    }
  })();
  return job.cleanup;
}

export function jobMetadata(job: Job): JobMetadata {
  return {
    id: job.id,
    command: preview(job.command, 256),
    cwd: preview(job.cwd, 512),
    ...(job.label === undefined ? {} : { label: preview(job.label, 128) }),
    status: job.status,
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.exit?.code == null ? {} : { exitCode: job.exit.code }),
    ...(job.exit?.signal == null ? {} : { signal: job.exit.signal }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...job.output.metadata(),
  };
}
