import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function provider(pi) {
  globalThis.fetch = () => {
    throw new Error("Network forbidden in deterministic Pi smoke");
  };
  pi.registerProvider("packed-fixture", {
    baseUrl: "http://127.0.0.1:1",
    api: "packed-fixture",
    apiKey: "local-not-a-secret",
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
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [],
        stopReason: "pending",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(async () => {
        await options?.onPayload?.({}, model);
        await options?.onResponse?.({ status: 200, headers: {} }, model);
        if (options?.signal?.aborted) {
          message.stopReason = "aborted";
          message.errorMessage = "Deterministic smoke request aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
          return;
        }
        stream.push({ type: "start", partial: message });
        const command = process.env.PI_SMOKE_CHILD_COMMAND;
        if (command !== undefined && !context.messages.some((m) => m.role === "toolResult")) {
          const toolCall = {
            type: "toolCall",
            id: "child-bash",
            name: "bash",
            arguments: { command },
          };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          message.content.push({ type: "text", text: "PACKED-CHILD-OK" });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "PACKED-CHILD-OK",
            partial: message,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: "PACKED-CHILD-OK",
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
