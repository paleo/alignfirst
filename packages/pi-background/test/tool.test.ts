import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateInput } from "../src/background-tool.js";
import { launchManaged as importLaunch, type ManagedProcess } from "../src/process-tree.js";
import { gate, host, jobFrom, waitFor } from "./host-fixture.js";

const TEST_GRACE_MS = 300;
const waitCommand = "while [ ! -f release ]; do sleep 0.02; done; printf 'done'; exit 0";

describe("public background actions", () => {
  it.each([
    {},
    { action: "wat" },
    { action: "list", command: "echo forbidden" },
    { action: "start", command: "  " },
    { action: "start", command: "x", timeout: 1 },
    { action: "start", command: "x", label: "😀".repeat(65) },
    { action: "start", command: "x", cwd: "\0" },
    { action: "status", id: "1234" },
    ...[0, -1, 1.5, 51201].map((maxBytes) => ({
      action: "output",
      id: "c710e799-2adf-4e40-a514-51a26bdd3631",
      maxBytes,
    })),
    { action: "stop", id: "c710e799-2adf-4e40-a514-51a26bdd3631", maxBytes: 1 },
  ])("refuses invalid input %j", (input) => {
    expect(() => validateInput(input)).toThrow();
  });

  it("acknowledges OS spawn without output, then retains bounded output and a terminal query", async () => {
    const h = await host();
    try {
      const job = jobFrom(
        await h.call({ action: "start", command: waitCommand, cwd: ".", label: "tests" }),
      );
      expect(job).toMatchObject({ status: "running", cwd: h.cwd, outputBytes: 0 });
      expect(h.requests).toHaveLength(0);
      await expect(h.call({ action: "clear", id: job.id })).rejects.toThrow("terminal");
      writeFileSync(join(h.cwd, "release"), "go");
      await waitFor(() => h.requests.length === 1);
      const status = jobFrom(await h.call({ action: "status", id: job.id }));
      expect(status).toMatchObject({ status: "succeeded", exitCode: 0, outputBytes: 4 });
      expect(await h.call({ action: "output", id: job.id })).toMatchObject({
        output: "done",
        returnedBytes: 4,
      });
      expect(await h.call({ action: "list" })).toMatchObject({ jobs: [status] });
      expect(await h.call({ action: "stop", id: job.id })).toMatchObject({ job: status });
      expect(await h.call({ action: "clear", id: job.id })).toMatchObject({ cleared: true });
      await expect(h.call({ action: "status", id: job.id })).rejects.toThrow("handle");
      expect(h.extensionErrors).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("preserves ordinary env but derives session and model metadata freshly", async () => {
    const h = await host();
    for (const name of [
      "PI_SESSION_ID",
      "PI_SESSION_FILE",
      "PI_PROVIDER",
      "PI_MODEL",
      "PI_REASONING_LEVEL",
    ])
      vi.stubEnv(name, "stale");
    vi.stubEnv("BACKGROUND_CREDENTIAL", "preserved");
    try {
      const command = `'${process.execPath}' -e 'require("fs").writeFileSync("env.json", JSON.stringify(process.env))'`;
      const job = jobFrom(await h.call({ action: "start", command }));
      await waitFor(() => existsSync(join(h.cwd, "env.json")));
      const env = JSON.parse(readFileSync(join(h.cwd, "env.json"), "utf8"));
      expect(env).toMatchObject({
        AI_AGENT: "pi",
        PI_CODING_AGENT: "true",
        BACKGROUND_CREDENTIAL: "preserved",
        PI_SESSION_ID: h.runtime.session.sessionId,
        PI_PROVIDER: "background-fixture",
        PI_MODEL: "local",
        PI_REASONING_LEVEL: "high",
      });
      expect(env.PI_SESSION_FILE).toBeUndefined();
      expect(job.cwd).toBe(h.cwd);
    } finally {
      await h.close();
    }
  });

  it("reports nonzero, signals, unknown shell commands and instant success without duplicate provider requests", async () => {
    const h = await host();
    try {
      for (const [command, outcome] of [
        ["exit 17", "failed"],
        ["kill -TERM $$", "failed"],
        ["missing_background_command_xyz", "failed"],
        ["true", "succeeded"],
      ]) {
        const count = h.requests.length;
        const job = jobFrom(await h.call({ action: "start", command }));
        await waitFor(() => h.requests.length === count + 1);
        await h.runtime.session.waitForIdle();
        expect(jobFrom(await h.call({ action: "status", id: job.id })).status).toBe(outcome);
      }
      expect(h.requests).toHaveLength(4);
    } finally {
      await h.close();
    }
  });

  it("refuses invalid cwd and OS spawn errors without retaining a job", async () => {
    const h = await host({
      background: {
        launch(options) {
          return importLaunch({ ...options, command: "/missing/shell" });
        },
      },
    });
    try {
      await expect(h.call({ action: "start", command: "true", cwd: "missing" })).rejects.toThrow(
        "ENOENT",
      );
      await expect(h.call({ action: "start", command: "true" })).rejects.toThrow("ENOENT");
      expect(await h.call({ action: "list" })).toEqual({ action: "list", jobs: [] });
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("reserves eight live slots synchronously across concurrent launches and shares stop cleanup", async () => {
    const h = await host();
    try {
      const pending = Array.from({ length: 9 }, () =>
        h.call({ action: "start", command: waitCommand }),
      );
      const results = await Promise.allSettled(pending);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const ids = results.flatMap((result) =>
        result.status === "fulfilled" ? [jobFrom(result.value).id] : [],
      );
      expect(new Set(ids).size).toBe(8);
      const stopped = await Promise.all(
        ids.flatMap((id) => [h.call({ action: "stop", id }), h.call({ action: "stop", id })]),
      );
      expect(stopped.every((result) => jobFrom(result).status === "cancelled")).toBe(true);
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("reserves 32 retained records and frees only explicitly cleared terminal records", async () => {
    const h = await host();
    try {
      const ids: string[] = [];
      for (let batch = 0; batch < 4; ++batch) {
        const jobs = await Promise.all(
          Array.from({ length: 8 }, () => h.call({ action: "start", command: "true" })),
        );
        ids.push(...jobs.map((result) => jobFrom(result).id));
        await waitFor(() => h.requests.length >= (batch + 1) * 8);
        await h.runtime.session.waitForIdle();
      }
      await expect(h.call({ action: "start", command: "true" })).rejects.toThrow("32");
      await h.call({ action: "clear", id: ids[0] });
      const replacement = jobFrom(await h.call({ action: "start", command: waitCommand }));
      expect(ids).not.toContain(replacement.id);
      await expect(h.call({ action: "clear", id: replacement.id })).rejects.toThrow("terminal");
    } finally {
      await h.close();
    }
  });

  it.each(["abort", "retire"])(
    "gates acknowledgement so %s wins even over instant exit",
    async (winner) => {
      const acknowledgement = gate();
      const entered = gate();
      const h = await host({
        background: {
          beforeAcknowledge: async () => {
            entered.release();
            await acknowledgement.promise;
          },
        },
      });
      const controller = new AbortController();
      const pending = h.call({ action: "start", command: "true" }, controller.signal);
      const observed = pending.catch((error: Error) => error.message);
      try {
        await entered.promise;
        const retiring = winner === "retire" ? h.runtime.newSession() : undefined;
        if (winner === "abort") controller.abort();
        acknowledgement.release();
        expect(await observed).toMatch(/cancelled|retired/);
        await retiring;
        expect(h.requests).toHaveLength(0);
        expect(await h.call({ action: "list" })).toEqual({ action: "list", jobs: [] });
      } finally {
        acknowledgement.release();
        await h.close();
      }
    },
  );

  it("keeps unresolved cleanup running, refuses clear/capacity eviction, shares attempts, and allows retry", async () => {
    const cleanupGate = gate();
    const cleanupEntered = gate();
    let attempts = 0;
    const h = await host({
      background: {
        launch(options) {
          const managed = importLaunch(options);
          const original = managed.stop;
          managed.stop = async (deadline) => {
            if (++attempts === 1) {
              cleanupEntered.release();
              await cleanupGate.promise;
              throw new Error("controlled inspection denied");
            }
            return original(deadline ?? Date.now() + TEST_GRACE_MS);
          };
          return managed;
        },
      },
    });
    try {
      const jobs = await Promise.all(
        Array.from({ length: 8 }, () => h.call({ action: "start", command: waitCommand })),
      );
      const id = jobFrom(jobs[0]).id;
      const first = h.call({ action: "stop", id });
      const second = h.call({ action: "stop", id });
      const observed = Promise.allSettled([first, second]);
      await cleanupEntered.promise;
      expect(attempts).toBe(1);
      cleanupGate.release();
      expect((await observed).every((result) => result.status === "rejected")).toBe(true);
      expect(jobFrom(await h.call({ action: "status", id }))).toMatchObject({
        status: "running",
        error: expect.stringContaining("Cleanup incomplete"),
      });
      await expect(h.call({ action: "clear", id })).rejects.toThrow("terminal");
      await expect(h.call({ action: "start", command: "true" })).rejects.toThrow("Eight");
      expect(jobFrom(await h.call({ action: "stop", id })).status).toBe("cancelled");
      expect(attempts).toBe(2);
      await h.call({ action: "clear", id });
      expect(h.requests).toHaveLength(0);
    } finally {
      cleanupGate.release();
      await h.close();
    }
  }, 15000);

  it("drains a real flood, returns only the newest bounded display, and bounds all metadata", async () => {
    const h = await host();
    try {
      const command = `'${process.execPath}' -e 'process.stdout.write("😀".repeat(600000) + "END")' # ${"x".repeat(8000)}`;
      const job = jobFrom(await h.call({ action: "start", command, label: "x".repeat(256) }));
      expect(job.command.endsWith("…[preview]")).toBe(true);
      expect(job.label?.endsWith("…[preview]")).toBe(true);
      await waitFor(() => h.requests.length === 1);
      const output = await h.call({ action: "output", id: job.id });
      if (!("output" in output)) throw new Error("Missing output.");
      expect(output.job).toMatchObject({
        status: "succeeded",
        outputBytes: 2400003,
        retainedBytes: 1048576,
        truncated: true,
      });
      expect(output.output.endsWith("END")).toBe(true);
      expect(output.output).not.toContain("�");
      expect(output.returnedBytes).toBeLessThanOrEqual(16384);
      const maximum = await h.call({ action: "output", id: job.id, maxBytes: 51200 });
      if (!("output" in maximum)) throw new Error("Missing output.");
      expect(maximum.returnedBytes).toBeLessThanOrEqual(51200);
      const listed = await h.call({ action: "list" });
      expect(JSON.stringify(listed).length).toBeLessThan(2000);
      if (!("jobs" in listed)) throw new Error("Missing jobs.");
      for (const privateKey of ["child", "process", "cleanup", "output", "stdout", "stderr"]) {
        expect(Object.keys(listed.jobs[0])).not.toContain(privateKey);
      }
    } finally {
      await h.close();
    }
  });

  it("holds an already-terminal completion until the launch is accepted", async () => {
    const entered = gate();
    const acknowledgement = gate();
    let managed: ManagedProcess | undefined;
    const h = await host({
      background: {
        launch(options) {
          managed = importLaunch(options);
          return managed;
        },
        beforeAcknowledge: async () => {
          entered.release();
          await acknowledgement.promise;
        },
      },
    });
    try {
      const pending = h.call({ action: "start", command: "true" });
      await entered.promise;
      if (!managed) throw new Error("Missing process.");
      await managed.exited;
      await managed.stop();
      expect(h.requests).toHaveLength(0);
      acknowledgement.release();
      const job = jobFrom(await pending);
      expect(job.status).toBe("succeeded");
      await waitFor(() => h.requests.length === 1);
      await h.runtime.session.waitForIdle();
      managed.child.emit("exit", 0, null);
      managed.child.emit("close", 0, null);
      managed.child.emit("error", new Error("late duplicate fixture callback"));
      await Promise.resolve();
      expect(jobFrom(await h.call({ action: "status", id: job.id })).status).toBe("succeeded");
      expect(h.requests).toHaveLength(1);
    } finally {
      acknowledgement.release();
      await h.close();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "naturally exited shells clean inherited pipes and preserve their actual exit outcome",
    async () => {
      const h = await host();
      let pid: number | undefined;
      let identity: string | undefined;
      try {
        const job = jobFrom(
          await h.call({
            action: "start",
            command:
              "sleep 60 & echo $! > descendant.pid; while [ ! -f exit ]; do sleep 0.02; done; exit 17",
          }),
        );
        await waitFor(() => existsSync(join(h.cwd, "descendant.pid")));
        pid = Number(readFileSync(join(h.cwd, "descendant.pid"), "utf8"));
        identity = processFields(pid)?.[19];
        expect(identity).toBeDefined();
        writeFileSync(join(h.cwd, "exit"), "go");
        const deadline = Date.now() + 8000;
        let status = jobFrom(await h.call({ action: "status", id: job.id }));
        while (status.status === "running" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          status = jobFrom(await h.call({ action: "status", id: job.id }));
        }
        expect(status).toMatchObject({ status: "failed", exitCode: 17 });
        expect(processFields(pid)?.[19] === identity && processFields(pid)?.[0] !== "Z").toBe(
          false,
        );
      } finally {
        if (
          pid !== undefined &&
          identity !== undefined &&
          processFields(pid)?.[19] === identity &&
          processFields(pid)?.[0] !== "Z"
        )
          process.kill(pid, "SIGKILL");
        await h.close();
      }
    },
  );

  it("detaches the launch abort listener at acknowledgement", async () => {
    const h = await host();
    const controller = new AbortController();
    try {
      const job = jobFrom(
        await h.call({ action: "start", command: waitCommand }, controller.signal),
      );
      controller.abort();
      expect(jobFrom(await h.call({ action: "status", id: job.id })).status).toBe("running");
      writeFileSync(join(h.cwd, "release"), "go");
      await waitFor(() => h.requests.length === 1);
      expect(jobFrom(await h.call({ action: "status", id: job.id })).status).toBe("succeeded");
    } finally {
      await h.close();
    }
  });
});

function processFields(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
