import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type JobMetadata, type JobRegistry, jobMetadata } from "./jobs.js";

export const Parameters = Type.Union([
  Type.Object(
    {
      action: Type.Literal("start"),
      command: Type.String({ minLength: 1, maxLength: 65536 }),
      cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
  handleAction("status"),
  handleAction("stop"),
  handleAction("clear"),
  Type.Object(
    {
      action: Type.Literal("output"),
      id: Type.String({
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      }),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 51200 })),
    },
    { additionalProperties: false },
  ),
]);

const JobSchema = Type.Object(
  {
    id: Type.String(),
    command: Type.String(),
    cwd: Type.String(),
    label: Type.Optional(Type.String()),
    status: Type.Union([
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    startedAt: Type.String(),
    finishedAt: Type.Optional(Type.String()),
    exitCode: Type.Optional(Type.Integer()),
    signal: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    outputBytes: Type.Number(),
    retainedBytes: Type.Number(),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const OutputSchema = Type.Union([
  Type.Object(
    { action: Type.Literal("list"), jobs: Type.Array(JobSchema, { maxItems: 32 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("clear"), id: Type.String(), cleared: Type.Literal(true) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("stop")]),
      job: JobSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("output"),
      job: JobSchema,
      output: Type.String(),
      returnedBytes: Type.Number(),
      outputBytes: Type.Number(),
      retainedBytes: Type.Number(),
      truncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

export type BackgroundInput = Static<typeof Parameters>;
export type BackgroundResult = Static<typeof OutputSchema>;

function handleAction<T extends string>(action: T) {
  return Type.Object(
    {
      action: Type.Literal(action),
      id: Type.String({
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      }),
    },
    { additionalProperties: false },
  );
}

export function validateInput(input: unknown): asserts input is BackgroundInput {
  if (!Value.Check(Parameters, input))
    throw new Error("Invalid background action or fields; inspect the tool schema.");
  if (
    "command" in input &&
    (input.command.trim() === "" ||
      Buffer.byteLength(input.command) > 65536 ||
      input.command.includes("\0"))
  ) {
    throw new Error("command must be nonblank, NUL-free, and at most 64 KiB.");
  }
  for (const key of ["cwd", "label"] as const) {
    if (!(key in input)) continue;
    const value =
      key === "cwd" && "cwd" in input ? input.cwd : "label" in input ? input.label : undefined;
    if (
      typeof value === "string" &&
      (value.trim() === "" ||
        value.includes("\0") ||
        Buffer.byteLength(value) > (key === "cwd" ? 4096 : 256))
    ) {
      throw new Error(
        `${key} must be nonblank, NUL-free, and at most ${key === "cwd" ? 4096 : 256} bytes.`,
      );
    }
  }
}

export async function executeAction(
  input: BackgroundInput,
  registry: JobRegistry,
  ctx: ExtensionContext,
  start: (input: { command: string; cwd?: string; label?: string }) => Promise<JobMetadata>,
): Promise<BackgroundResult> {
  validateInput(input);
  if (input.action === "start" && "command" in input)
    return { action: "start", job: await start(input) };
  if (input.action === "list") return { action: "list", jobs: registry.list() };
  if (!("id" in input)) throw new Error("Background action requires a handle.");
  if (input.action === "stop") return { action: "stop", job: await registry.stop(input.id) };
  if (input.action === "clear") {
    registry.clear(input.id);
    return { action: "clear", id: input.id, cleared: true };
  }
  const job = registry.get(input.id);
  if (input.action === "status") return { action: "status", job: jobMetadata(job) };
  if (input.action !== "output") throw new Error("Unknown background action.");
  const snapshot = job.output.read(
    "maxBytes" in input && typeof input.maxBytes === "number" ? input.maxBytes : 16384,
  );
  if (!registry.active() || ctx.sessionManager.getSessionId() !== registry.origin.sessionId) {
    throw new Error("Background owner retired during output retrieval.");
  }
  return { action: "output", job: jobMetadata(job), ...snapshot };
}
