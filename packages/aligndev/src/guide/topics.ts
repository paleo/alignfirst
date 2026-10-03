import type { Platform } from "../config.js";

// The template rendered by `aligndev guide` without a topic.
export const PLAYBOOK_DISPATCHER = "playbook";

// The playbook topics each platform serves. Every topic is one file of `templates/guide/playbook/`,
// shared by the platforms through platform blocks.
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
  codingAgent: ["working-session", "project-workspace-setup", "consultation"],
};
