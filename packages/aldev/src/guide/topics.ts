import type { Platform } from "../config.js";

// The template rendered by `aldev guide` without a topic.
export const PLAYBOOK_DISPATCHER = "playbook";

// Each key has a template directory, `templates/guide/<platform>/`, holding one file per topic.
export const PLAYBOOK_TOPICS: Record<Platform, readonly string[]> = {
  openclaw: [
    "channel-handling",
    "working-session",
    "project-workspace-setup",
    "project-lifecycle",
    "consultation",
    "slack-message-tool",
    "discord-message-tool",
  ],
};
