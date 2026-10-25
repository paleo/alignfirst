import { type ActiveBlocks, SURFACES, type Surface } from "./render-template.js";

// `templates/guide/playbook/dispatcher.md`, printed by `aligndev guide` without a topic.
export const PLAYBOOK_DISPATCHER = "dispatcher";

// `templates/guide/playbook/playbook.md`, the operating instructions.
export const PLAYBOOK = "playbook";

// The topics printed after the playbook.
export const ENTRY_TOPICS: readonly string[] = ["working-session", "channel-handling"];

// The playbook topics each context serves. Every topic is one file of `templates/guide/playbook/`,
// shared by the contexts through fact blocks.
export const PLAYBOOK_TOPICS: Record<GuideContext, readonly string[]> = {
  thread: [
    "channel-handling",
    "working-session",
    "work-files-setup",
    "project-workspace-setup",
    "project-lifecycle",
    "consultation",
    "message-tool",
  ],
  app: [
    "working-session",
    "work-files-setup",
    "project-workspace-setup",
    "project-lifecycle",
    "consultation",
  ],
  codingAgent: ["working-session", "work-files-setup", "project-workspace-setup", "consultation"],
};

export type GuideContext = "thread" | "app" | "codingAgent";

export function guideContextOf(active: ActiveBlocks): GuideContext {
  if (active.platform === "codingAgent") return "codingAgent";
  return active.surface === "app" ? "app" : "thread";
}

export function surfacesServing(topic: string): Surface[] {
  return SURFACES.filter((surface) =>
    PLAYBOOK_TOPICS[guideContextOf({ platform: "openclaw", surface })].includes(topic),
  );
}
