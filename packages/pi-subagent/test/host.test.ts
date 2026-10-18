import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { launchManaged } from "../src/process-tree.js";

const cli = fileURLToPath(
  new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const provider = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));

describe("actual Pi 1.3.0 headless parent", () => {
  it.each(["user", "both", "approved", "untrusted"])(
    "runs headless parallel delegation with %s profile scope",
    async (scope) => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-headless-"));
      const config = join(cwd, "config");
      const captures = join(cwd, "captures");
      mkdirSync(config);
      mkdirSync(captures);
      if (scope !== "user") {
        mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
        writeFileSync(
          join(cwd, ".pi", "agents", "worker.md"),
          "---\nname: worker\ndescription: trusted fixture\ntools: [read, bash, edit, write]\n---\nGENERIC-PROJECT-PROFILE",
        );
        if (scope === "both") new ProjectTrustStore(config).set(cwd, true);
        if (scope === "approved") writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
      }
      writeFileSync(
        join(config, "settings.json"),
        JSON.stringify({
          extensions: [provider],
          defaultProvider: "subagent-fixture",
          defaultModel: "local",
          skills: [],
          promptTemplates: [],
          compaction: { enabled: false },
        }),
      );
      let stdout = "";
      let stderr = "";
      const managed = launchManaged({
        command: process.execPath,
        args: [
          cli,
          ...(scope === "approved" ? ["--approve"] : []),
          "--mode",
          "json",
          "--print",
          "--no-session",
          "--no-extensions",
          "-e",
          provider,
          "-e",
          extension,
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-themes",
          "--offline",
          "--model",
          "subagent-fixture/local",
          "--tools",
          "subagent",
          "--thinking",
          "low",
        ],
        cwd,
        env: {
          ...process.env,
          HOME: cwd,
          PI_CODING_AGENT_DIR: config,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          SUBAGENT_PARENT_TASK: "/skill:literal-child\n$(not shell) @file  \n\t",
          SUBAGENT_PARENT_SCOPE: scope === "user" ? "user" : "both",
          SUBAGENT_FIXTURE_CAPTURE_DIR: captures,
        },
        stdout(chunk) {
          stdout += chunk.toString();
        },
        stderr(chunk) {
          stderr += chunk.toString();
        },
        inputError: () => {},
      });
      managed.child.stdin.end("PARENT-PRIVATE-CONVERSATION: delegate now.");
      let timer: NodeJS.Timeout | undefined;
      try {
        const exit = await Promise.race([
          managed.exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Headless parent timed out:\n${stderr}\n${stdout}`)),
              15_000,
            );
          }),
        ]);
        await managed.stop();
        expect(exit.code, stderr).toBe(0);
        const events: unknown[] = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const toolEvent = events.find(
          (event) =>
            isRecord(event) && event.type === "tool_execution_end" && event.toolName === "subagent",
        );
        if (scope === "untrusted") {
          expect(toolEvent).toMatchObject({ isError: true });
          expect(JSON.stringify(toolEvent)).toContain("/trust");
          expect(
            readdirSync(captures).every((file) => file.startsWith(`${managed.child.pid}-`)),
          ).toBe(true);
          return;
        }
        expect(toolEvent).toMatchObject({
          isError: false,
          result: {
            usage: { totalTokens: 10 },
            structuredContent: {
              mode: "parallel",
              results: [
                {
                  agent: "worker",
                  agentSource: scope === "user" ? "bundled" : "project",
                  status: "succeeded",
                  model: "subagent-fixture/local",
                  thinking: "low",
                  output: "fixture complete",
                },
                { agent: "worker", status: "succeeded", output: "fixture complete" },
              ],
            },
          },
        });
        const children = readdirSync(captures).filter(
          (file) => !file.startsWith(`${managed.child.pid}-`),
        );
        expect(children).toHaveLength(2);
        const parents = readdirSync(captures).filter((file) =>
          file.startsWith(`${managed.child.pid}-`),
        );
        expect(
          parents.some((file) =>
            readFileSync(join(captures, file), "utf8").includes("TRANSIENT-PARENT-ALIGNDEV-ROLE"),
          ),
        ).toBe(true);
        for (const child of children) {
          const text = readFileSync(join(captures, child), "utf8");
          expect(text).not.toContain("PARENT-PRIVATE-CONVERSATION");
          expect(text).not.toContain("TRANSIENT-PARENT-ALIGNDEV-ROLE");
          if (scope !== "user") expect(text).toContain("GENERIC-PROJECT-PROFILE");
        }
        expect(
          children
            .map((file) => readFileSync(join(captures, file), "utf8"))
            .some((text) =>
              text.includes(
                "Task:\\n/skill:literal-child\\n$(not shell) @file  \\n\\t\\nEnd of task.",
              ),
            ),
        ).toBe(true);
      } finally {
        clearTimeout(timer);
        await managed.stop(Date.now());
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
