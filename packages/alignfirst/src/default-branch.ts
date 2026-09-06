import { gitOutputOrUndefined, gitSucceeds } from "./git.js";
import type { ProjectConfig } from "./project-config.js";

export interface DefaultBranch {
  name: string;
  source: "config" | "cached";
  remote?: string;
}

export function resolveDefaultBranch(
  cwd: string,
  config: ProjectConfig | undefined,
): DefaultBranch | undefined {
  const configured = config?.git?.defaultBranch;
  if (configured !== undefined) return { name: configured, source: "config" };
  const remote = resolveRemote(cwd);
  if (remote === undefined) return;
  const prefix = `refs/remotes/${remote}/`;
  const target = gitOutputOrUndefined(cwd, "symbolic-ref", "-q", `${prefix}HEAD`);
  if (target === undefined || target === "" || !target.startsWith(prefix)) return;
  if (!gitSucceeds(cwd, "rev-parse", "--verify", "-q", target)) return;
  return { name: target.slice(prefix.length), source: "cached", remote };
}

function resolveRemote(cwd: string): string | undefined {
  const output = gitOutputOrUndefined(cwd, "remote");
  if (output === undefined || output === "") return;
  const remotes = output.split("\n").filter((remote) => remote !== "");
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0] : undefined;
}

export function renderDefaultBranchLine(branch: DefaultBranch | undefined): string {
  if (branch === undefined)
    return "Default branch: unresolved; ask before default-branch operations.";
  return branch.source === "cached"
    ? `Default branch: ${branch.name} (cached).`
    : `Default branch: ${branch.name}.`;
}
