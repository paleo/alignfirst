import type { LaunchEvidence } from "@alignfirst/docmap/invocation";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { renderCommandForm } from "../src/command-form.js";
import { makeSink, makeTempDir } from "./helpers.js";

const devConfig = {
  schemaVersion: 1,
  devServer: {
    ports: { first: 28100, last: 28199, declare: ["app"] },
    servers: [
      {
        kind: "spawn",
        name: "app",
        exec: { run: ["false"] },
        ready: { log: "ready" },
      },
    ],
  },
};

describe("command form", () => {
  it.each([
    ["node", {}, "alignfirst"],
    [
      "node",
      { npm_config_user_agent: "npm/12", npm_command: "exec", npm_lifecycle_event: "npx" },
      "npx -y alignfirst",
    ],
    ["node", { npm_config_user_agent: "bun/1.4.4", npm_command: "exec" }, "bunx alignfirst"],
    ["bun", { npm_config_user_agent: "bun/1.4.4", npm_command: "exec" }, "bunx --bun alignfirst"],
    ["bun", {}, "bunx --bun alignfirst"],
  ] as const)(
    "propagates %s/%j through help, context, assistant instructions, docmap and guides",
    async (runtime, env, form) => {
      const cwd = makeTempDir("alignfirst-command-form-");
      try {
        writeFileSync(join(cwd, "alignfirst.json"), JSON.stringify(devConfig));
        mkdirSync(join(cwd, "docs"));
        writeFileSync(join(cwd, "docs", "topic.md"), "# Topic\n");
        const evidence = { runtime, env, cwd, executable: "/runtime" };
        for (const args of [
          ["--help"],
          ["context"],
          ["assistant-instructions"],
          ["guide", "spec"],
          ["guide", "spec", "--protocol-only"],
          ["docmap", "--guide", "--root", "docs with spaces"],
        ]) {
          const { code, output } = await runWithEvidence(args, evidence);
          expect(code).toBe(0);
          expect(output).toContain(form);
          if (form === "alignfirst") expect(output).not.toMatch(/\b(?:npx|bunx)\b/);
          if (args[0] === "context" || args[0] === "assistant-instructions") {
            expect(output).toContain(`run \`${form} workspace --guide\` and follow it`);
            expect(output).toContain(`${form} dev up     # start in the background`);
            expect(output).toContain(`${form} dev status # inspect its status`);
            expect(output).toContain(`${form} dev down   # stop it`);
          }
          if (args[0] === "context") expect(output).toContain(`${form} docmap dir-a`);
          if (args[0] === "docmap")
            expect(output).toContain(`${form} docmap --root 'docs with spaces'`);
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it("forwards follow-up arguments through a verified npm script", async () => {
    const cwd = makeTempDir("alignfirst-script-");
    try {
      const entryPoint = join(cwd, "alignfirst.mjs");
      const manifest = join(cwd, "package.json");
      const script = `node ${entryPoint}`;
      writeFileSync(entryPoint, "");
      writeFileSync(manifest, JSON.stringify({ scripts: { af: script } }));
      writeFileSync(join(cwd, "alignfirst.json"), JSON.stringify(devConfig));
      const env = {
        npm_config_user_agent: "npm/11",
        npm_command: "run",
        npm_lifecycle_event: "af",
        npm_lifecycle_script: script,
        npm_package_json: manifest,
      };
      const evidence: LaunchEvidence = {
        runtime: "node",
        env,
        cwd,
        entryPoint,
        executable: "/runtime",
        parentArgv: ["/bin/sh", "-c", script],
      };
      for (const command of ["guide", "context", "assistant-instructions"]) {
        const { code, output } = await runWithEvidence([command], evidence);
        expect(code).toBe(0);
        if (command === "guide") {
          expect(output).toContain("npm run af -- guide spec");
        } else {
          expect(output).toContain("run `npm run af -- workspace --guide` and follow it");
          expect(output).toContain("npm run af -- dev up     # start in the background");
          expect(output).toContain("npm run af -- dev status # inspect its status");
          expect(output).toContain("npm run af -- dev down   # stop it");
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(["", "$&", "$'", "$`", "$$"])("renders every placeholder literally with %j", (token) => {
    const form = `npm run 'af${token}' --`;
    expect(renderCommandForm("{{CMD}} guide; {{CMD}} ticket", form)).toBe(
      `${form} guide; ${form} ticket`,
    );
  });
});

async function runWithEvidence(
  args: string[],
  evidence: LaunchEvidence,
): Promise<{ code: number; output: string }> {
  const stdout = makeSink();
  const code = await main({
    argv: ["runtime", "alignfirst", ...args],
    cwd: evidence.cwd,
    home: evidence.cwd,
    env: evidence.env,
    evidence,
    stdout,
    stderr: makeSink(),
  });
  return { code, output: stdout.text() };
}
