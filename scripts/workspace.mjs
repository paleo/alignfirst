import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWorkspace } from "@paleo/workspace";

await runWorkspace({
  scriptPath: fileURLToPath(import.meta.url),
  sharedDirs: [".plans", ".local"],
  runtimeDir: ".local-wt",
  configFiles: [
    { path: ".vscode/settings.json", source: { kind: "mainWorktree" }, optional: true },
  ],
  finalizeWorktree: ({ currentWorktree, progress }) => {
    progress("npm install");
    execSync("npm install", { stdio: "inherit", cwd: currentWorktree });
    progress("npm run build");
    execSync("npm run build", { stdio: "inherit", cwd: currentWorktree });
  },
  printSummary: ({ name, branch, currentWorktree, isMainWorktree, status }) => `
Workspace ${name} — ${status}
  Type:   ${isMainWorktree ? "main" : "linked"}
  Branch: ${branch}
  Path:   ${currentWorktree}
`,
});
