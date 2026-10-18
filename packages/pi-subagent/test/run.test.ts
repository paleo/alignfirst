import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyUsage } from "../src/json-output.js";
import type { PiAssignment, PiOutcome, PiProcessOptions } from "../src/pi-process.js";
import { type DispatchContext, dispatch } from "../src/run.js";

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dispatch", () => {
  it.each([
    {},
    { tasks: [] },
    { chain: [] },
    { task: " " },
    { task: "x", agent: " " },
    { task: "x", model: "" },
    { task: "x", thinking: "extreme" },
    { task: "x", tasks: [{ task: "y" }] },
    { tasks: [{ task: "x" }], cwd: "elsewhere" },
    { chain: [{ task: "" }] },
    { tasks: Array.from({ length: 9 }, () => ({ task: "x" })) },
    { task: "x", confirmProjectAgents: false },
  ])("rejects invalid/mixed input %#", async (input) => {
    await expect(dispatch(input, context())).rejects.toThrow();
  });

  it("resolves cwd from parent and model/thinking independently from dispatch snapshots", async () => {
    const ctx = context();
    mkdirSync(join(ctx.agentDir ?? "", "agents"), { recursive: true });
    writeFileSync(
      join(ctx.agentDir ?? "", "agents", "named.md"),
      "---\nname: named\ndescription: fixture\nmodel: profile/model\n---\nPrompt",
    );
    const captured: PiAssignment[] = [];
    ctx.runner = async (assignment) => {
      captured.push(assignment);
      return success(assignment.task);
    };
    const result = await dispatch(
      {
        tasks: [
          { task: "one", agent: "named", cwd: "child" },
          { task: "two", agent: "named", model: "task/model", thinking: "max" },
          { task: "three" },
        ],
        thinking: "low",
      },
      ctx,
    );
    expect(captured[0]).toMatchObject({
      cwd: join(ctx.cwd, "child"),
      model: "profile/model",
      thinking: "low",
    });
    expect(captured[1]).toMatchObject({ model: "task/model", thinking: "max" });
    expect(captured[2]).toMatchObject({ model: "parent/model", thinking: "low" });
    expect(result.usage.totalTokens).toBe(15);
    const top = await dispatch({ task: "top", agent: "named", model: "top/model" }, ctx);
    expect(top.data.results[0]).toMatchObject({ model: "top/model", thinking: "high" });
  });

  it("keeps parent project profile discovery independent of task cwd", async () => {
    const ctx = context();
    for (const dir of [ctx.cwd, join(ctx.cwd, "child")]) {
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "agents", "worker.md"),
        `---\nname: worker\ndescription: fixture\nmodel: ${dir === ctx.cwd ? "parent/profile" : "wrong/profile"}\n---\nPrompt`,
      );
    }
    const result = await dispatch(
      { task: "work", cwd: "child", agentScope: "both" },
      { ...ctx, trusted: true },
    );
    expect(result.data.results[0]).toMatchObject({
      model: "parent/profile",
      agentSource: "project",
      cwd: join(ctx.cwd, "child"),
    });
    await expect(dispatch({ task: "work", agentScope: "both" }, ctx)).rejects.toThrow("/trust");
  });

  it("limits concurrency to four and preserves input order and successful siblings", async () => {
    const ctx = context();
    let live = 0;
    let peak = 0;
    ctx.runner = async (assignment) => {
      peak = Math.max(peak, ++live);
      await new Promise((resolve) => setTimeout(resolve, 15 - Number(assignment.task)));
      --live;
      return {
        ...success(assignment.task),
        status: assignment.task === "2" ? "failed" : "succeeded",
      };
    };
    const result = await dispatch(
      { tasks: Array.from({ length: 8 }, (_, index) => ({ task: String(index) })) },
      ctx,
    );
    expect(peak).toBe(4);
    expect(result.isError).toBe(true);
    expect(result.data.results.map((task) => task.output)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
    expect(result.data.results.filter((task) => task.status === "succeeded")).toHaveLength(7);
  });

  it("does not launch queued tasks after cancellation and awaits running siblings", async () => {
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    let launches = 0;
    let cleaned = 0;
    ctx.runner = async (_assignment, options) => {
      ++launches;
      await new Promise<void>((resolve) =>
        options.signal.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              ++cleaned;
              resolve();
            }, 30);
          },
          { once: true },
        ),
      );
      return { ...success(""), status: "cancelled" };
    };
    const pending = dispatch({ tasks: Array.from({ length: 8 }, () => ({ task: "work" })) }, ctx);
    controller.abort();
    const result = await pending;
    expect(launches).toBe(4);
    expect(cleaned).toBe(4);
    expect(result.data.results.map((task) => task.status)).toEqual(Array(8).fill("cancelled"));
  });

  it("substitutes literal predecessor output and stops chains on failure", async () => {
    const ctx = context();
    const tasks: string[] = [];
    ctx.runner = async (assignment) => {
      tasks.push(assignment.task);
      return {
        ...success(assignment.task === "first" ? "$& literal" : "second"),
        status: tasks.length === 2 ? "failed" : "succeeded",
      };
    };
    const result = await dispatch(
      { chain: [{ task: "first" }, { task: "next {previous}" }, { task: "never" }] },
      ctx,
    );
    expect(tasks).toEqual(["first", "next $& literal"]);
    expect(result.data.results).toHaveLength(2);
    expect(result.isError).toBe(true);
  });

  it("refuses a truncated chain handoff", async () => {
    const ctx = context();
    ctx.runner = async () => ({ ...success("partial"), truncated: true });
    const result = await dispatch({ chain: [{ task: "first" }, { task: "next {previous}" }] }, ctx);
    expect(result.data.results).toHaveLength(1);
    expect(result.data.results[0]).toMatchObject({ status: "failed", truncated: true });
    expect(result.data.results[0].error).toContain("predecessor output");
  });

  it("budgets headings as well as answers across a long chain", async () => {
    const ctx = context();
    ctx.runner = async () => success("x".repeat(75));
    const result = await dispatch(
      { chain: Array.from({ length: 500 }, () => ({ task: "x" })) },
      ctx,
    );
    expect(result.data.results).toHaveLength(500);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024);
    expect(result.data.results.every((task) => task.truncated)).toBe(true);
  });

  it.each(["single", "parallel", "chain"])(
    "bounds total model content and retained text in %s",
    async (mode) => {
      const ctx = context();
      ctx.runner = async () => ({
        ...success("😀".repeat(30_000)),
        error: "diagnostic".repeat(2000),
      });
      const input =
        mode === "single"
          ? { task: "x" }
          : mode === "parallel"
            ? { tasks: Array.from({ length: 8 }, () => ({ task: "x" })) }
            : { chain: Array.from({ length: 20 }, () => ({ task: "x" })) };
      const result = await dispatch(input, ctx);
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024);
      expect(result.data.results.every((task) => task.truncated)).toBe(true);
      expect(
        result.data.results.reduce((sum, task) => sum + Buffer.byteLength(task.output), 0),
      ).toBeLessThanOrEqual(40 * 1024);
      expect(result.text).toContain("truncated");
    },
  );
});

function context(): DispatchContext {
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-run-"));
  directories.push(cwd);
  return {
    cwd,
    agentDir: join(cwd, "user"),
    model: "parent/model",
    thinking: "high",
    trusted: false,
    signal: new AbortController().signal,
    active: () => true,
    own: () => {},
    release: () => {},
    runner: async (assignment: PiAssignment, _options: PiProcessOptions) =>
      success(assignment.task),
  };
}

function success(output: string): PiOutcome {
  return {
    status: "succeeded",
    output,
    truncated: false,
    usage: { ...emptyUsage(), input: 2, output: 3, totalTokens: 5 },
  };
}
