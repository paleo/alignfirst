import type { CommandContext } from "./context.js";

export function renderWorkspaceGuidance(ctx: CommandContext): string {
  const config = ctx.projectConfig?.config;
  const guide = `${ctx.form} workspace --guide`;
  const workspace =
    config?.workspace !== undefined || config?.devServer !== undefined
      ? `This project uses AlignFirst **workspaces**: Git worktrees with project-specific preparation. Before managing workspaces or worktrees, run \`${guide}\` and follow it.`
      : `For worktree preparation and lifecycle operations, see \`${guide}\`.`;
  const sections = [`# Workspace\n\n${workspace}\n`];
  if (config?.devServer !== undefined) {
    sections.push(
      "# Development Server\n\n" +
        "Use the project's AlignFirst commands to manage the development environment:\n\n" +
        "```bash\n" +
        `${ctx.form} dev up     # start in the background\n` +
        `${ctx.form} dev status # inspect its status\n` +
        `${ctx.form} dev down   # stop it\n` +
        "```\n",
    );
  }
  return sections.join("\n");
}
