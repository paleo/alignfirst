import { runWorkspace } from "@paleo/workspace";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

await runWorkspace({
  workspaceScript: fileURLToPath(import.meta.url),
  sharedDirs: [".plans", ".local", "alignfirst-developer-tests/artifacts"],
  runtimeDir: ".local-wt",
  gitignoredFiles: [
    { path: ".vscode/settings.json", source: { kind: "mainWorktree" }, optional: true },
    {
      path: "alignfirst-developer-tests/.env.local",
      source: { kind: "mainWorktree" },
      optional: true,
    },
  ],
  finalizeWorkspace: ({ currentWorktree, progress }) => {
    progress("npm install");
    execSync("npm install", { stdio: "inherit", cwd: currentWorktree });
    progress("npm run build");
    execSync("npm run build", { stdio: "inherit", cwd: currentWorktree });
  },
  formatSummary: ({ name, branch, currentWorktree, isMainWorktree, status }) => `
Workspace ${name} — ${status}
  Type:   ${isMainWorktree ? "main" : "linked"}
  Branch: ${branch}
  Path:   ${currentWorktree}
`,
});
