// Workspace lifecycle wrapper. Stripped fixture mirror of a real product
// script: same shape, runs `pnpm install` like the real one; no docker, no
// migrations, no builds, no config patching.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWorkspace } from "@paleo/workspace";

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
      patch: (content, { ports }) => content.replace(/^PORT=.*$/m, `PORT=${ports.frontend}`),
    },
  ],

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
