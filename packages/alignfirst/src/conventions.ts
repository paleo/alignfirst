import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

import type { CommandContext } from "./context.js";
import { renderDefaultBranchLine, resolveDefaultBranch } from "./default-branch.js";
import { gitOutputOrUndefined, gitSucceeds } from "./git.js";
import { resolvePlansMode } from "./plans/mode.js";
import type { CommitConfig } from "./project-config.js";

export interface CommitSubject {
  subject: string;
  side?: string;
}

export function renderConventions(ctx: CommandContext): string {
  const lines = [
    renderTicketIds(ctx),
    renderBranchNames(ctx),
    renderCommits(ctx),
    renderDefaultBranchLine(resolveDefaultBranch(ctx.cwd, ctx.projectConfig?.config)),
    renderPlans(ctx),
    renderSearches(ctx),
  ].filter((line) => line !== undefined);
  return `${lines.join("\n")}\n`;
}

function renderTicketIds(ctx: CommandContext): string {
  const pattern = ctx.projectConfig?.config.ticketIdPattern;
  if (pattern === undefined)
    return "Ticket IDs: no configured format; ask the user for the ID. Without an external ticket, use the next `side-N`.";
  return `Ticket IDs: \`${pattern}\`; infer a matching ID from the branch. Without an external ticket, use the next \`side-N\`.`;
}

function renderBranchNames(ctx: CommandContext): string | undefined {
  const template = ctx.projectConfig?.config.git?.branchNameTemplate;
  return template === undefined ? undefined : `Branch names: \`${template}\`.`;
}

function renderCommits(ctx: CommandContext): string | undefined {
  const git = ctx.projectConfig?.config.git;
  if (git?.commit === undefined) {
    return git?.agentCoauthoring === false
      ? "Commits: do not add an agent co-author trailer."
      : undefined;
  }
  const { subject, side } = commitSubject(git.commit);
  const rule = side === undefined ? `${subject}.` : `${subject}; use ${side}.`;
  const coauthor = git.agentCoauthoring === false ? " Do not add an agent co-author trailer." : "";
  return `Commits: ${rule}${coauthor}`;
}

export function commitSubject(commit: CommitConfig): CommitSubject {
  if (commit.ticketReference === "bracketed")
    return { subject: "`type: [ticketId] summary`", side: "`type: summary` for `side-N`" };
  if (commit.ticketReference === "bracketedHash")
    return { subject: "`type: [#ticketId] summary`", side: "`type: summary` for `side-N`" };
  return { subject: "`type: summary`" };
}

function renderPlans(ctx: CommandContext): string | undefined {
  if (!plansEntryExists(ctx.cwd)) return;
  try {
    const mode = resolvePlansMode(ctx.cwd, ctx.form);
    const folder = ctx.projectConfig?.config.plans?.folder;
    const sharedFolder = folder === undefined ? "" : ` (shared folder \`${folder}\`)`;
    const base =
      mode.kind === "shared"
        ? `Plans: use \`.plans\`${sharedFolder}; keep it out of product commits, and run \`${ctx.form} sync\` after changes.`
        : "Plans: use `.plans`; keep it out of product commits.";
    const archival =
      ctx.projectConfig?.config.plans?.autoArchive === true
        ? " Automatic archival is enabled."
        : "";
    return `${base}${archival}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Plans: ${message.split("\n", 1)[0]}`;
  }
}

function plansEntryExists(cwd: string): boolean {
  return lstatSync(join(cwd, ".plans"), { throwIfNoEntry: false }) !== undefined;
}

function renderSearches(ctx: CommandContext): string | undefined {
  const directories = [
    ...(plansEntryExists(ctx.cwd) ? [".plans"] : []),
    ...[".local", ".local-wt"].filter((name) => qualifiesIgnoredDirectory(ctx.cwd, name)),
  ];
  if (directories.length === 0) return;
  const rendered = directories.map((name) => `\`${name}\``);
  const joined =
    rendered.length === 1
      ? rendered[0]
      : `${rendered.slice(0, -1).join(", ")} and ${rendered.at(-1)}`;
  return `Searches: exclude ${joined} from broad codebase searches.`;
}

function qualifiesIgnoredDirectory(cwd: string, name: string): boolean {
  return (
    existsSync(join(cwd, name)) &&
    gitSucceeds(cwd, "check-ignore", "-q", name) &&
    gitOutputOrUndefined(cwd, "ls-files", "--", name) === ""
  );
}
