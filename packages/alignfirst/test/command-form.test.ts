import { resolveInvocation } from "@alignfirst/docmap/invocation";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCliRange } from "../src/version-guard.js";
import { main } from "../src/cli.js";
import { describe, expect, it } from "vitest";

import { renderCommandForm, resolveCommandForm } from "../src/command-form.js";

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
      expect(resolveCommandForm(env, evidence)).toBe(form);
      for (const args of [
        ["--help"],
        ["context"],
        ["guide", "spec"],
        ["guide", "spec", "--protocol-only"],
        ["docmap", "--guide", "--root", "docs with spaces"],
      ]) {
        let output = "";
        const code = await main({
          argv: ["runtime", "alignfirst", ...args],
          cwd: "/tmp",
          home: "/tmp",
          env,
          evidence,
          stdout: {
            write: (s) => {
              output += s;
            },
          },
          stderr: { write: () => {} },
        });
        expect(code).toBe(0);
        expect(output).toContain(form);
        if (args[0] === "docmap")
          expect(output).toContain(`${form} docmap --root 'docs with spaces'`);
      }
    },
  );
  it.each(["npm", "bun"] as const)(
    "keeps verified %s self scripts but rejects inherited aligndev ownership",
    (manager) => {
      const cwd = mkdtempSync(join(tmpdir(), "alignfirst-script-"));
      try {
        const entryPoint = join(cwd, "alignfirst.mjs");
        const otherEntry = join(cwd, "aligndev.mjs");
        const manifest = join(cwd, "package.json");
        const script = `node ${entryPoint}`;
        const otherScript = `node ${otherEntry}`;
        writeFileSync(entryPoint, "");
        writeFileSync(otherEntry, "");
        writeFileSync(manifest, JSON.stringify({ scripts: { af: script, dev: otherScript } }));
        const env = {
          npm_config_user_agent: `${manager}/1`,
          npm_command: manager === "npm" ? "run" : "run-script",
          npm_lifecycle_event: "af",
          npm_lifecycle_script: script,
          npm_package_json: manifest,
        };
        const evidence = {
          runtime: manager === "bun" ? ("bun" as const) : ("node" as const),
          env,
          cwd,
          entryPoint,
          executable: "/runtime",
          parentArgv: ["/bin/sh", "-c", script],
        };
        expect(resolveCommandForm(env, evidence)).toBe(
          manager === "npm" ? "npm run af --" : "bun --bun run af",
        );
        const inherited = { ...env, npm_lifecycle_event: "dev", npm_lifecycle_script: otherScript };
        expect(
          resolveCommandForm(inherited, {
            ...evidence,
            env: inherited,
            parentArgv: ["/bin/sh", "-c", otherScript],
          }),
        ).toBe(manager === "npm" ? "npx -y alignfirst" : "bunx --bun alignfirst");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it("uses the installed binary outside a package runner", () => {
    expect(resolveCommandForm({})).toBe("alignfirst");
    expect(resolveCommandForm({ npm_config_user_agent: "" })).toBe("alignfirst");
  });

  it("uses npx inside a package runner", () => {
    expect(
      resolveCommandForm({
        npm_config_user_agent: "npm/11",
        npm_command: "exec",
        npm_lifecycle_event: "npx",
      }),
    ).toBe("npx -y alignfirst");
  });

  it("retains the version constraint, Bun runtime and quoted arguments in recovery", () => {
    const invocation = resolveInvocation(
      { packageName: "alignfirst", binaryName: "alignfirst" },
      { runtime: "bun", env: {}, cwd: "/tmp", executable: "/bun" },
    );
    expect(() =>
      checkCliRange(
        { schemaVersion: 1, cli: ">=9 <10" },
        "0.1.0",
        ["docmap", "--root", "a'b"],
        invocation,
      ),
    ).toThrow("bunx --bun 'alignfirst@>=9 <10' docmap --root 'a'\\''b'");
  });

  it("renders every placeholder", () => {
    expect(renderCommandForm("{{CMD}} guide; {{CMD}} ticket", "alignfirst")).toBe(
      "alignfirst guide; alignfirst ticket",
    );
  });
});
