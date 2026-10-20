import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWorkspace } from "@alignfirst/workspace";

await runWorkspace({
  workspaceScript: fileURLToPath(import.meta.url),
  devServerScript: fileURLToPath(new URL("./dev-server.mjs", import.meta.url)),
  sharedDirs: [".local", ".plans"],
  runtimeDir: ".local-wt",
  gitignoredFiles: [],

  finalizeWorkspace: async ({ currentWorktree }) => {
    execSync("pnpm install --frozen-lockfile", {
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
