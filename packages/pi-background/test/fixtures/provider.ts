import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  getCurrentTools,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function provider(pi: ExtensionAPI) {
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
        contextWindow: 100000,
        maxTokens: 8000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const calledTool = context.messages.some((message) => message.role === "toolResult");
      const isParent = getCurrentTools(context.messages).some((tool) => tool.name === "background");
      const command = isParent
        ? process.env.BACKGROUND_PARENT_COMMAND
        : process.env.SUBAGENT_FIXTURE_COMMAND;
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
      const finish = () => {
        stream.push({ type: "start", partial: message });
        if (command !== undefined && !calledTool) {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: "fixture-command",
            name: isParent ? "background" : "bash",
            arguments: isParent ? { action: "start", command } : { command },
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
      };
      if (isParent && calledTool) {
        const abort = () => {
          message.stopReason = "aborted";
          message.errorMessage = "fixture aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        if (options?.signal?.aborted) abort();
      } else queueMicrotask(finish);
      return stream;
    },
  });
}
