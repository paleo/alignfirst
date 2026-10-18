import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function provider(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    if (
      process.env.SUBAGENT_PARENT_TASK !== undefined &&
      pi.getActiveTools().includes("subagent")
    ) {
      return {
        systemPrompt: `${event.systemPrompt}\nTRANSIENT-PARENT-ALIGNDEV-ROLE: never copy this role to children.`,
      };
    }
  });
  let request = 0;
  pi.registerProvider("subagent-fixture", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "deterministic-not-a-secret",
    api: "fixture",
    models: [
      {
        id: "local",
        name: "local",
        input: ["text"],
        reasoning: true,
        contextWindow: 100_000,
        maxTokens: 8_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const calledTool = context.messages.some((message) => message.role === "toolResult");
      const command = process.env.SUBAGENT_FIXTURE_COMMAND;
      const parentTask = process.env.SUBAGENT_PARENT_TASK;
      const isParent =
        parentTask !== undefined &&
        getCurrentTools(context.messages).some((tool) => tool.name === "subagent");
      const capture = process.env.SUBAGENT_FIXTURE_CAPTURE;
      if (capture !== undefined) writeFileSync(capture, JSON.stringify(context));
      const directory = process.env.SUBAGENT_FIXTURE_CAPTURE_DIR;
      if (directory !== undefined)
        writeFileSync(join(directory, `${process.pid}-${++request}.json`), JSON.stringify(context));
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "pending",
        content: [],
        usage: {
          input: 2,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (isParent && !calledTool) {
          const toolCall = {
            type: "toolCall" as const,
            id: "fixture-subagent",
            name: "subagent",
            arguments: {
              tasks: [{ task: parentTask }, { task: "second assignment" }],
              agentScope: process.env.SUBAGENT_PARENT_SCOPE ?? "user",
            },
          };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
        } else if (command !== undefined && !calledTool) {
          const toolCall = {
            type: "toolCall" as const,
            id: "fixture-bash",
            name: "bash",
            arguments: { command },
          };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          message.content.push({ type: "text", text: "fixture complete" });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "fixture complete",
            partial: message,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: "fixture complete",
            partial: message,
          });
          message.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end(message);
      });
      return stream;
    },
  });
}
