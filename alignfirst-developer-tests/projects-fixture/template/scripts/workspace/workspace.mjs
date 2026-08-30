// Workspace lifecycle wrapper. Stripped fixture mirror of a real product
// script: same shape, runs `pnpm install` like the real one; no docker,
// migrations, or builds.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { helpers, runWorkspace } from "@paleo/workspace";

await runWorkspace({
  workspaceScript: fileURLToPath(import.meta.url),
  devServerScript: fileURLToPath(new URL("./dev-server.mjs", import.meta.url)),

  ports: {
    // `scripts/reset-fixture.mjs` rewrites this line per fixture, so two
    // fixtures materialized side by side never share a port block.
    base: 6500,
    perWorkspace: 2,
    maxWorkspaces: 10,
    names: ["frontend"],
  },

  sharedDirs: [".local", ".plans"],
  runtimeDir: ".local-wt",

  gitignoredFiles: [
    {
      path: "local.env",
      source: { kind: "committed", path: "local.env.example" },
      patch: (content, { ports }) =>
        helpers.patchEnvFile(content, {
          PORT: String(ports.frontend),
          PUBLIC_URL: publicUrl(content, ports.frontend),
        }),
    },
  ],

  preSetup: ({ profile }) => {
    const domain = process.env.REMOTE_DEV_DOMAIN;
    if (profile === "remote" && (domain === undefined || domain === "")) {
      throw new Error("REMOTE_DEV_DOMAIN is not set.");
    }
  },
  setupProfiles: {
    remote: {
      description: "public URL through the dev-server gateway (REMOTE_DEV_DOMAIN)",
      apply: ({ currentWorktree, ports }) => {
        const domain = process.env.REMOTE_DEV_DOMAIN;
        if (domain === undefined || domain === "") {
          throw new Error("REMOTE_DEV_DOMAIN is not set.");
        }
        const envFile = join(currentWorktree, "local.env");
        const content = readFileSync(envFile, "utf8");
        const patched = helpers.patchEnvFile(content, {
          PUBLIC_URL: `https://p${ports.frontend}.${domain}`,
        });
        if (patched !== content) writeFileSync(envFile, patched);
      },
    },
  },

  finalizeWorkspace: async ({ currentWorktree }) => {
    execSync("pnpm install --frozen-lockfile --prod=false", {
      stdio: "inherit",
      cwd: currentWorktree,
    });
  },

  formatSummary: ({ name, branch, currentWorktree, isMainWorktree, status }) => `
Workspace setup complete!
  Worktree type: ${isMainWorktree ? "main" : "linked"}
  Status:        ${status}
  Workspace:     ${name}
  Branch:        ${branch}
  Path:          ${currentWorktree}
`,
});

function publicUrl(content, port) {
  const host = helpers.extractHost(content, "PUBLIC_URL");
  const remote = host.match(/^p\d+\.(.+)$/);
  return remote ? `https://p${port}.${remote[1]}` : `http://${host}:${port}`;
}
