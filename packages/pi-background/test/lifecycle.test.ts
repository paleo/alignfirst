import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { launchManaged, type ManagedProcess } from "../src/process-tree.js";
import { gate, host, jobFrom, readPidFile, waitFor, waitJob } from "./host-fixture.js";

const waitCommand = "while [ ! -f release ]; do sleep 0.02; done; printf 'PRIVATE-LOG'; exit 0";

describe("actual Pi 1.3.0 native completion", () => {
  it("returns a launch tool result and acknowledgement before idle completion requests another provider turn", async () => {
    const h = await host({
      respond: (request) =>
        request === 1
          ? { tool: { action: "start", command: waitCommand, label: "test" } }
          : { text: "ack" },
    });
    try {
      await h.runtime.session.prompt("Start and acknowledge.");
      expect(h.requests).toHaveLength(2);
      const listed = await h.call({ action: "list" });
      if (!("jobs" in listed)) throw new Error("Missing jobs.");
      const job = listed.jobs[0];
      expect(job.status).toBe("running");
      writeFileSync(join(h.cwd, "release"), "go");
      await waitFor(() => h.requests.length === 3);
      await h.runtime.session.waitForIdle();
      const notice = notices(h.requests[2]);
      expect(notice).toHaveLength(1);
      expect(notice[0].content).toContain(job.id);
      expect(notice[0].content).not.toContain("PRIVATE-LOG");
      expect(notice[0].content).not.toContain(waitCommand);
      expect(notice[0].content).toContain("untrusted");
      expect(h.extensionErrors).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("actual parent abort cancels a tool launch before the gated acknowledgement", async () => {
    const entered = gate();
    const acknowledgement = gate();
    const processes: ManagedProcess[] = [];
    const h = await host({
      respond: () => ({ tool: { action: "start", command: waitCommand } }),
      background: {
        launch(options) {
          const child = launchManaged(options);
          processes.push(child);
          return child;
        },
        beforeAcknowledge: async () => {
          entered.release();
          await acknowledgement.promise;
        },
      },
    });
    try {
      const pending = h.runtime.session.prompt("Launch the command.");
      await entered.promise;
      const aborting = h.runtime.session.abort();
      acknowledgement.release();
      await aborting;
      await pending;
      expect(await h.call({ action: "list" })).toEqual({ action: "list", jobs: [] });
      expect(h.requests).toHaveLength(1);
      expect(processes[0].child.exitCode !== null || processes[0].child.signalCode !== null).toBe(
        true,
      );
      await processes[0].closed;
    } finally {
      acknowledgement.release();
      await h.close();
    }
  }, 15000);

  it("follows busy work without steering and leaves established jobs alive after parent abort", async () => {
    const busy = gate();
    const h = await host({
      respond: async (request) => {
        if (request === 1) await busy.promise;
        return { text: "busy complete" };
      },
    });
    try {
      const job = jobFrom(await h.call({ action: "start", command: waitCommand }));
      const pending = h.runtime.session.prompt("Work while the command runs.");
      await waitFor(() => h.requests.length === 1);
      writeFileSync(join(h.cwd, "release"), "go");
      await waitJob(h, job.id);
      expect(h.requests).toHaveLength(1);
      busy.release();
      await pending;
      expect(h.requests).toHaveLength(2);
      expect(notices(h.requests[0])).toHaveLength(0);
      expect(notices(h.requests[1])).toHaveLength(1);
      const next = jobFrom(
        await h.call({ action: "start", command: "while [ ! -f release2 ]; do sleep 0.02; done" }),
      );
      const interrupted = h.runtime.session.prompt("Another ordinary response.");
      await waitFor(() => h.requests.length === 3);
      await h.runtime.session.abort();
      await interrupted;
      expect(jobFrom(await h.call({ action: "status", id: next.id })).status).toBe("running");
    } finally {
      busy.release();
      await h.close();
    }
  });

  it.each(["before", "after"] as const)(
    "manual compaction held by an %s handler retains completion until an ordinary turn, then restores native handoff",
    async (order) => {
      for (const outcome of ["success", "failure", "cancel", "abort"] as const) {
        const entered = gate();
        const release = gate();
        let summarizing = false;
        const blocker: ExtensionFactory = (pi) => {
          pi.on("session_before_compact", async (event) => {
            entered.release();
            await release.promise;
            if (outcome === "failure") return;
            if (outcome === "cancel") return { cancel: true };
            return {
              compaction: {
                summary: "fixture summary",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            };
          });
        };
        const h = await host({
          [order]: [blocker],
          respond: () =>
            summarizing && outcome === "failure"
              ? { error: "fixture compaction failure" }
              : { text: "ack" },
        });
        try {
          await h.runtime.session.prompt("seed one");
          await h.runtime.session.prompt("seed two");
          const job = jobFrom(await h.call({ action: "start", command: waitCommand }));
          summarizing = true;
          const pending = h.runtime.session.compact().catch((error: Error) => error);
          await entered.promise;
          writeFileSync(join(h.cwd, "release"), "go");
          await waitJob(h, job.id);
          expect(h.requests).toHaveLength(2);
          if (outcome === "abort") h.runtime.session.abortCompaction();
          release.release();
          const compacted = await pending;
          summarizing = false;
          if (outcome !== "success") expect(compacted).toBeInstanceOf(Error);
          expect(h.requests.slice(2).every((request) => notices(request).length === 0)).toBe(true);
          await h.runtime.session.prompt("Recover retained context.");
          expect(notices(h.requests.at(-1))).toHaveLength(1);
          expect(notices(h.requests.at(-1))[0].content).toContain(job.id);
          const second = jobFrom(
            await h.call({
              action: "start",
              command: "while [ ! -f release2 ]; do sleep 0.02; done",
            }),
          );
          const count = h.requests.length;
          writeFileSync(join(h.cwd, "release2"), "go");
          await waitFor(() => h.requests.length === count + 1);
          expect(
            notices(h.requests.at(-1)).some((notice) => String(notice.content).includes(second.id)),
          ).toBe(true);
        } finally {
          release.release();
          await h.close();
        }
      }
    },
    20000,
  );

  it.each(["before", "after"] as const)(
    "tree navigation held by an %s handler suppresses wake during success/cancellation/failure",
    async (order) => {
      for (const outcome of ["success", "cancel", "failure"] as const) {
        const entered = gate();
        const release = gate();
        const blocker: ExtensionFactory = (pi) => {
          pi.on("session_before_tree", async () => {
            entered.release();
            await release.promise;
            if (outcome === "cancel") return { cancel: true };
            if (outcome === "failure") return;
          });
        };
        const h = await host({
          [order]: [blocker],
          respond: (request) =>
            outcome === "failure" && request === 3
              ? { error: "fixture tree failure" }
              : { text: "ack" },
        });
        try {
          await h.runtime.session.prompt("first");
          const target = h.runtime.session.sessionManager.getLeafId();
          if (target === null) throw new Error("Missing target.");
          await h.runtime.session.prompt("second");
          const job = jobFrom(await h.call({ action: "start", command: waitCommand }));
          const pending = h.runtime.session
            .navigateTree(target, { summarize: outcome === "failure" })
            .catch((error: Error) => error);
          await entered.promise;
          writeFileSync(join(h.cwd, "release"), "go");
          await waitJob(h, job.id);
          expect(h.requests).toHaveLength(2);
          release.release();
          const navigated = await pending;
          if (outcome === "failure") expect(navigated).toBeInstanceOf(Error);
          if (outcome === "success")
            await expect(h.call({ action: "status", id: job.id })).rejects.toThrow("handle");
          else
            expect(jobFrom(await h.call({ action: "status", id: job.id })).status).toBe(
              "succeeded",
            );
          await h.runtime.session.prompt("ordinary recovery");
          expect(notices(h.requests.at(-1))).toHaveLength(outcome === "success" ? 0 : 1);
        } finally {
          release.release();
          await h.close();
        }
      }
    },
    15000,
  );

  it.each(["success", "abort", "failure"] as const)(
    "holds completion during real tree summary generation with %s outcome",
    async (outcome) => {
      const summary = gate();
      const h = await host({
        respond: async (request) => {
          if (request === 3) {
            await summary.promise;
            if (outcome === "failure") return { error: "fixture summary failure" };
          }
          return { text: "summary" };
        },
      });
      try {
        await h.runtime.session.prompt("first");
        const target = h.runtime.session.sessionManager.getLeafId();
        if (target === null) throw new Error("Missing target.");
        await h.runtime.session.prompt("second");
        const job = jobFrom(await h.call({ action: "start", command: waitCommand }));
        const navigating = h.runtime.session
          .navigateTree(target, { summarize: true })
          .catch((error: Error) => error);
        await waitFor(() => h.requests.length === 3);
        writeFileSync(join(h.cwd, "release"), "go");
        await waitJob(h, job.id);
        expect(h.requests).toHaveLength(3);
        expect(notices(h.requests[2])).toHaveLength(0);
        if (outcome === "abort") h.runtime.session.abortBranchSummary();
        summary.release();
        const result = await navigating;
        if (outcome === "success")
          await expect(h.call({ action: "status", id: job.id })).rejects.toThrow("handle");
        else {
          if (outcome === "failure") expect(result).toBeInstanceOf(Error);
          else expect(result).toMatchObject({ cancelled: true, aborted: true });
          expect(jobFrom(await h.call({ action: "status", id: job.id })).status).toBe("succeeded");
        }
        await h.runtime.session.prompt("continue");
        expect(notices(h.requests.at(-1))).toHaveLength(outcome === "success" ? 0 : 1);
      } finally {
        summary.release();
        await h.close();
      }
    },
  );

  it("keeps the native follow-up path during automatic compaction inside an observed active run", async () => {
    const entered = gate();
    const release = gate();
    let id = "";
    const h = await host({
      automaticCompaction: true,
      respond: (request) =>
        request === 1 ? { tool: { action: "status", id }, inputTokens: 95001 } : { text: "done" },
      after: [
        (pi) => {
          pi.on("session_before_compact", async (event) => {
            expect(event.reason).toBe("threshold");
            entered.release();
            await release.promise;
            return {
              compaction: {
                summary: "auto summary",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            };
          });
        },
      ],
    });
    try {
      id = jobFrom(await h.call({ action: "start", command: waitCommand })).id;
      const running = h.runtime.session.prompt("Work with automatic compaction.");
      await entered.promise;
      writeFileSync(join(h.cwd, "release"), "go");
      await waitJob(h, id);
      expect(h.requests).toHaveLength(1);
      release.release();
      await running;
      expect(
        h.requests
          .slice(1)
          .some((request) =>
            notices(request).some((notice) => String(notice.content).includes(id)),
          ),
      ).toBe(true);
    } finally {
      release.release();
      await h.close();
    }
  });

  it.each(["reload", "tree", "clear"] as const)(
    "permits a submitted native follow-up to survive abort and %s, but rejects its stale handle",
    async (replacement) => {
      const busy = gate();
      const h = await host({
        respond: async (request) => {
          if (request === 2) await busy.promise;
          return { text: "ack" };
        },
      });
      try {
        await h.runtime.session.prompt("seed");
        const target = h.runtime.session.sessionManager.getLeafId();
        if (target === null) throw new Error("Missing target.");
        const job = jobFrom(await h.call({ action: "start", command: waitCommand }));
        const pending = h.runtime.session.prompt("hold");
        await waitFor(() => h.requests.length === 2);
        writeFileSync(join(h.cwd, "release"), "go");
        await waitJob(h, job.id);
        expect(h.requests).toHaveLength(2);
        await h.runtime.session.abort();
        await pending;
        const rewrite = vi.spyOn(h.runtime.session, "clearQueue");
        if (replacement === "reload") await h.runtime.session.reload();
        else if (replacement === "clear") await h.call({ action: "clear", id: job.id });
        else await h.runtime.session.navigateTree(target);
        await expect(h.call({ action: "status", id: job.id })).rejects.toThrow("handle");
        busy.release();
        await h.runtime.session.prompt("later ordinary user turn");
        const stale = h.requests
          .slice(2)
          .flatMap(notices)
          .filter((notice) => String(notice.content).includes(job.id));
        expect(stale.length).toBeGreaterThan(0);
        expect(stale[0].content).toContain('"runtimeId"');
        expect(stale[0].content).toContain('"generation":0');
        expect(stale[0].content).toContain("Ignore unknown/retired");
        expect(rewrite).not.toHaveBeenCalled();
      } finally {
        busy.release();
        await h.close();
      }
    },
  );

  it("clear discards an unsent guarded notice without creating a later turn", async () => {
    const entered = gate();
    const release = gate();
    const h = await host({
      before: [
        (pi) => {
          pi.on("session_before_compact", async (event) => {
            entered.release();
            await release.promise;
            return {
              compaction: {
                summary: "summary",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            };
          });
        },
      ],
    });
    try {
      await h.runtime.session.prompt("first");
      await h.runtime.session.prompt("second");
      const job = jobFrom(await h.call({ action: "start", command: waitCommand }));
      const compacting = h.runtime.session.compact();
      await entered.promise;
      writeFileSync(join(h.cwd, "release"), "go");
      await waitJob(h, job.id);
      await h.call({ action: "clear", id: job.id });
      expect(h.requests).toHaveLength(2);
      release.release();
      await compacting;
      await h.runtime.session.prompt("ordinary recovery");
      expect(h.requests).toHaveLength(3);
      expect(notices(h.requests[2])).toHaveLength(0);
    } finally {
      release.release();
      await h.close();
    }
  });

  it("does not recreate a native notice after explicit host queue clearing", async () => {
    const busy = gate();
    const h = await host({
      respond: async (request) => {
        if (request === 1) await busy.promise;
        return { text: "ack" };
      },
    });
    try {
      const job = jobFrom(await h.call({ action: "start", command: waitCommand }));
      const pending = h.runtime.session.prompt("hold");
      await waitFor(() => h.requests.length === 1);
      writeFileSync(join(h.cwd, "release"), "go");
      await waitJob(h, job.id);
      h.runtime.session.clearQueue();
      await h.runtime.session.abort();
      await pending;
      busy.release();
      await h.runtime.session.prompt("later");
      expect(h.requests).toHaveLength(2);
      expect(notices(h.requests[1])).toHaveLength(0);
    } finally {
      busy.release();
      await h.close();
    }
  });
});

describe.skipIf(process.platform !== "linux")("actual runtime process retirement", () => {
  it("successful tree movement stops still-running branch work before exposing the replacement generation", async () => {
    const processes: ManagedProcess[] = [];
    const h = await host({
      background: {
        launch(options) {
          const child = launchManaged(options);
          processes.push(child);
          return child;
        },
      },
    });
    try {
      await h.runtime.session.prompt("first");
      const target = h.runtime.session.sessionManager.getLeafId();
      if (target === null) throw new Error("Missing target.");
      await h.runtime.session.prompt("second");
      const job = jobFrom(
        await h.call({
          action: "start",
          command: `exec '${process.execPath}' -e 'setInterval(()=>{},1000)'`,
        }),
      );
      const pid = processes[0].child.pid;
      if (pid === undefined) throw new Error("Missing child pid.");
      await h.runtime.session.navigateTree(target);
      expect(processes[0].child.signalCode).not.toBeNull();
      await processes[0].closed;
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(h.call({ action: "status", id: job.id })).rejects.toThrow("handle");
      expect(h.requests).toHaveLength(2);
    } finally {
      await h.close();
    }
  });
  it.each(["new", "resume", "fork", "reload", "quit"] as const)(
    "%s awaits reaping before replacement and refuses old handles",
    async (operation) => {
      const processes: ManagedProcess[] = [];
      const h = await host({
        persisted: true,
        background: {
          launch(options) {
            const child = launchManaged(options);
            processes.push(child);
            return child;
          },
        },
      });
      try {
        await h.runtime.session.prompt("seed");
        const original = h.runtime.session.sessionFile;
        const target = h.runtime.session.sessionManager
          .getBranch()
          .find((entry) => entry.type === "message" && entry.message.role === "user");
        if (!original || !target) throw new Error("Missing persisted session fixture.");
        const job = jobFrom(
          await h.call({
            action: "start",
            command: `exec '${process.execPath}' -e 'require("fs").writeFileSync("pid", String(process.pid)); setInterval(()=>{}, 1000)'`,
          }),
        );
        const pid = await readPidFile(join(h.cwd, "pid"));
        expect(pid).toBe(processes[0].child.pid);
        if (operation === "new") await h.runtime.newSession();
        else if (operation === "resume") await h.runtime.switchSession(original);
        else if (operation === "fork") await h.runtime.fork(target.id);
        else if (operation === "reload") await h.runtime.session.reload();
        else await h.runtime.dispose();
        expect(processes[0].child.signalCode).not.toBeNull();
        await processes[0].closed;
        expect(() => process.kill(pid, 0)).toThrow();
        await expect(h.call({ action: "status", id: job.id })).rejects.toThrow();
        expect(h.requests).toHaveLength(1);
      } finally {
        await h.close();
      }
    },
  );

  it.each(["backgroundFirst", "subagentFirst"] as const)(
    "loads both packages in %s order and distinguishes callbacks before/after local shutdown invalidation",
    async (order) => {
      const background = fileURLToPath(new URL("../src/index.ts", import.meta.url));
      const subagent = fileURLToPath(new URL("../../pi-subagent/src/index.ts", import.meta.url));
      const earlierEntered = gate();
      const earlierRelease = gate();
      const laterEntered = gate();
      const laterRelease = gate();
      const h = await host({
        fileExtensions:
          order === "backgroundFirst" ? [background, subagent] : [subagent, background],
        tools: ["background", "subagent"],
        before: [
          (pi) => {
            pi.on("session_shutdown", async () => {
              earlierEntered.release();
              await earlierRelease.promise;
            });
          },
        ],
        after: [
          (pi) => {
            pi.on("session_shutdown", async () => {
              laterEntered.release();
              await laterRelease.promise;
            });
          },
        ],
      });
      let replacing: Promise<unknown> | undefined;
      let nested: Promise<unknown> | undefined;
      const descendants: { pid: number; identity: string }[] = [];
      try {
        expect(h.runtime.session.getActiveToolNames()).toContain("background");
        const directory = join(h.cwd, "subagent-tree");
        mkdirSync(directory);
        const fixture = fileURLToPath(new URL("./fixtures/tree.mjs", import.meta.url));
        const provider = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));
        writeFileSync(
          join(h.cwd, "config", "settings.json"),
          JSON.stringify({ extensions: [provider] }),
        );
        vi.stubEnv(
          "SUBAGENT_FIXTURE_COMMAND",
          `'${process.execPath}' '${fixture}' '${directory}' grouped`,
        );
        const tool = h.runtime.session.agent.state.tools.find((tool) => tool.name === "subagent");
        if (!tool) throw new Error("Actual sibling tool missing.");
        nested = tool.execute("nested", {
          task: "Run the deterministic bash fixture.",
          model: "subagent-fixture/local",
        });
        await waitFor(
          () => readdirSync(directory).filter((name) => /^\d+\.json$/.test(name)).length >= 3,
        );
        for (const name of readdirSync(directory).filter((name) => /^\d+\.json$/.test(name))) {
          const pid = Number(name.slice(0, -5));
          const identity = processFields(pid)?.[19];
          if (identity === undefined)
            throw new Error("Nested fixture disappeared before shutdown.");
          descendants.push({ pid, identity });
        }
        const early = jobFrom(await h.call({ action: "start", command: waitCommand }));
        const late = jobFrom(
          await h.call({
            action: "start",
            command: "while [ ! -f release2 ]; do sleep 0.02; done",
          }),
        );
        replacing = h.runtime.newSession();
        await earlierEntered.promise;
        writeFileSync(join(h.cwd, "release"), "go");
        await waitJob(h, early.id);
        await waitFor(() => h.requests.length === 1);
        expect(notices(h.requests[0])[0].content).toContain(early.id);
        expect(notices(h.requests[0])[0].content).toContain('"runtimeId"');
        earlierRelease.release();
        await laterEntered.promise;
        expect(await nested).toMatchObject({
          isError: true,
          details: { results: [{ status: "cancelled" }] },
        });
        expect(
          descendants.filter(
            (record) =>
              processFields(record.pid)?.[19] === record.identity &&
              processFields(record.pid)?.[0] !== "Z",
          ),
        ).toEqual([]);
        await expect(h.call({ action: "status", id: late.id })).rejects.toThrow("lifecycle");
        expect(h.requests).toHaveLength(1);
        expect(h.requests.flatMap(notices).some((notice) => notice.content.includes(late.id))).toBe(
          false,
        );
        laterRelease.release();
        await replacing;
        await expect(h.call({ action: "status", id: early.id })).rejects.toThrow("handle");
        expect(h.extensionErrors).toEqual([]);
      } finally {
        earlierRelease.release();
        laterRelease.release();
        await replacing;
        for (const record of descendants) {
          if (
            processFields(record.pid)?.[19] === record.identity &&
            processFields(record.pid)?.[0] !== "Z"
          )
            process.kill(record.pid, "SIGKILL");
        }
        await h.close();
        await nested;
      }
    },
    15000,
  );
});

function processFields(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    )
      return;
    throw error;
  }
}

function notices(context?: TranscriptContext) {
  return (
    context?.messages.flatMap((message) => {
      if (message.role !== "user") return [];
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      return content.startsWith("Background completion.") ? [{ content }] : [];
    }) ?? []
  );
}
