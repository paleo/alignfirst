// Workspace lifecycle wrapper. Stripped fixture mirror of a real product
// script: same shape, runs `pnpm install` like the real one; no docker, no
// migrations, no builds, no config patching.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWorkspace } from "@paleo/workspace";

await runWorkspace({
  scriptPath: fileURLToPath(import.meta.url),
  devServerScript: fileURLToPath(new URL("./dev-server.mjs", import.meta.url)),

  basePort: 6500,
  portNames: ["frontend"],

  sharedDirs: [".local", ".plans"],
  runtimeDir: ".local-wt",

  configFiles: [
    {
      path: "local.env",
      source: { kind: "newWorktree", path: "local.env.example" },
      patch: (content, { ports }) => content.replace(/^PORT=.*$/m, `PORT=${ports.frontend}`),
    },
  ],

  finalizeWorktree: async ({ currentWorktree }) => {
    execSync("pnpm install --frozen-lockfile --prod=false", {
      stdio: "inherit",
      cwd: currentWorktree,
    });
  },

  printSummary: ({ slot, branch, currentWorktree, isMainWorktree, status }) => `
Workspace setup complete!
  Worktree type: ${isMainWorktree ? "main" : "linked"}
  Status: ${status}
  Slot:   ${slot}
  Branch: ${branch}
  Path:   ${currentWorktree}
`,
});
