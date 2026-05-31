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
  registryDir: ".local/_workspace-registry",

  configFiles: [],

  finalizeWorktree: async ({ currentWorktree }) => {
    execSync("pnpm install --frozen-lockfile --prod=false", {
      stdio: "inherit",
      cwd: currentWorktree,
    });
  },

  printSummary: ({ slot, branch, owner, currentWorktree, isMainWorktree, status }) => `
Workspace setup complete!
  Worktree type: ${isMainWorktree ? "main" : "linked"}
  Status: ${status}
  Slot:   ${slot}
  Branch: ${branch}${owner ? `\n  Owner:  ${owner}` : ""}
  Path:   ${currentWorktree}
`,
});
