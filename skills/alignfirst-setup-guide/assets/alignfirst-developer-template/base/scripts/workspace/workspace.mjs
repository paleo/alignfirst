// Workspace lifecycle wrapper. This repository holds runbooks and configuration — no build,
// no dev server — so the system runs portless.

import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWorkspace } from "@paleo/workspace";

await runWorkspace({
  workspaceScript: fileURLToPath(import.meta.url),
  sharedDirs: [".local", ".plans"],
  runtimeDir: ".local-wt",
  gitignoredFiles: [],
  // TEAM_PLANS_SECTION
  preSetup: ({ isMainWorktree, currentWorktree }) => {
    if (!isMainWorktree) return;
    execFileSync("npx", ["--no", "plans-share", "check"], {
      cwd: currentWorktree,
      stdio: "inherit",
    });
  },
  // TEAM_PLANS_SECTION
  finalizeWorkspace: ({ currentWorktree, progress }) => {
    progress("npm install");
    execSync("npm install", { stdio: "inherit", cwd: currentWorktree });
  },
  formatSummary: ({ name, branch, currentWorktree, isMainWorktree, status }) => `
Workspace ${name} — ${status}
  Type:   ${isMainWorktree ? "main" : "linked"}
  Branch: ${branch}
  Path:   ${currentWorktree}
`,
});
