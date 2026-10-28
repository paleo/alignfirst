import type { LaunchEvidence } from "@alignfirst/docmap/invocation";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { renderCommandForm } from "../src/command-form.js";
import { makeSink, makeTempDir } from "./helpers.js";

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
    "propagates %s/%j through help, context, embedded docmap and protocol guides",
    async (runtime, env, form) => {
      const evidence = { runtime, env, cwd: "/tmp", executable: "/runtime" };
      for (const args of [
        ["--help"],
        ["context"],
        ["guide", "spec"],
        ["guide", "spec", "--protocol-only"],
        ["docmap", "--guide", "--root", "docs with spaces"],
      ]) {
        const { code, output } = await runWithEvidence(args, evidence);
        expect(code).toBe(0);
        expect(output).toContain(form);
        if (form === "alignfirst") expect(output).not.toMatch(/\b(?:npx|bunx)\b/);
        if (args[0] === "docmap")
          expect(output).toContain(`${form} docmap --root 'docs with spaces'`);
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
      const env = {
        npm_config_user_agent: "npm/11",
        npm_command: "run",
        npm_lifecycle_event: "af",
        npm_lifecycle_script: script,
        npm_package_json: manifest,
      };
      const { code, output } = await runWithEvidence(["guide"], {
        runtime: "node",
        env,
        cwd,
        entryPoint,
        executable: "/runtime",
        parentArgv: ["/bin/sh", "-c", script],
      });
      expect(code).toBe(0);
      expect(output).toContain("npm run af -- guide spec");
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
