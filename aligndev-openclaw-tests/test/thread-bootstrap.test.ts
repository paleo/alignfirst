import assert from "node:assert/strict";
import { test } from "node:test";
import type { BusMessage, ScenarioContext } from "@alignfirst/openclaw-test";
import { bootstrapThreadFromChannel } from "../scenarios/_lib/thread-bootstrap.ts";

const PROJECT_PATH = "/home/assistant/projects/nimbus";
const REQUESTS = [
  {
    name: "short explicit no-ticket request",
    text: "Sur nimbus, sans ticket, remplace Export par Download.",
    omissions: ["sans ticket, "],
  },
  {
    name: "itemized multi-constraint request",
    text: `Sur nimbus, sans ticket, améliore le libellé d'export.

- Remplace Export par Download dans label.mjs.
- Adapte le test label.test.mjs et exécute npm test.
- Lance directement, sans validation supplémentaire.
- Ne pousse rien et arrête-toi après les tests.`,
    omissions: [
      "Sur nimbus, sans ticket, améliore le libellé d'export.\n\n",
      "sans ticket, ",
      "- Adapte le test label.test.mjs et exécute npm test.\n",
      "- Lance directement, sans validation supplémentaire.\n",
      "- Ne pousse rien et arrête-toi après les tests.",
    ],
  },
];

for (const channel of ["slack-mock", "discord-mock"]) {
  for (const request of REQUESTS) {
    test(`${channel}: bootstrap requires the complete ${request.name}`, async () => {
      const checked = new Error("offline starter assertions completed");
      const opts = {
        text: request.text,
        project: "nimbus",
        projectPath: PROJECT_PATH,
        request: request.text,
        afterStarter: async () => {
          throw checked;
        },
      };
      const starter = (original: string) =>
        `Tâche: Remplacer Export par Download.\nProjet: nimbus\nChemin: ${PROJECT_PATH}\n\nDemande:\n${original}\n\nPrêt pour la session de travail.`;

      // Stop after the real bootstrap assertions; no handoff, gateway or provider is exercised.
      await assert.rejects(
        bootstrapThreadFromChannel(offlineContext(channel, starter(request.text)), opts),
        (error) => error === checked,
      );
      for (const omission of request.omissions) {
        await assert.rejects(
          bootstrapThreadFromChannel(
            offlineContext(channel, starter(request.text.replace(omission, ""))),
            opts,
          ),
          /starter omitted the detailed request/,
        );
      }
      await assert.rejects(
        bootstrapThreadFromChannel(offlineContext(channel, starter("")), opts),
        /starter omitted the detailed request/,
      );
    });
  }
}

function offlineContext(channel: string, text: string): ScenarioContext {
  const message: BusMessage = {
    id: "starter",
    accountId: channel,
    direction: "outbound",
    conversation: { id: "offline-bootstrap", kind: "channel" },
    senderId: "openclaw",
    text,
    timestamp: 0,
    threadId: "thread-1",
    reactions: [],
  };
  const supported: Partial<ScenarioContext> = {
    channel,
    conversationId: message.conversation.id,
    getCursor: async () => 0,
    sendInbound: async (input) => ({
      message: { ...message, ...input, direction: "inbound" },
      entry: {
        kind: "inboundSent",
        ts: "offline",
        entrySeq: 0,
        messageId: "inbound",
        ...input,
      },
    }),
    waitForOutbound: async (predicate) => {
      assert.equal(predicate(message), true);
      return {
        match: message,
        entry: {
          kind: "outboundReceived",
          ts: "offline",
          entrySeq: 1,
          messageId: message.id,
          text,
          threadId: message.threadId,
        },
        nextCursor: 1,
      };
    },
    log: () => {},
    assertRegex: (actual, pattern) => assert.match(actual, pattern),
  };
  // Only the starter boundary is mocked; fail on any service, provider or handoff operation.
  return new Proxy(supported, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return Reflect.get(target, key);
      throw new Error(`unexpected offline bootstrap operation: ${String(key)}`);
    },
  }) as ScenarioContext;
}
