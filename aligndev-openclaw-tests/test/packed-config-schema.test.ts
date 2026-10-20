import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createChannelMockPlugin } from "@alignfirst/openclaw-channel-mock-core";

const hostRequire = createRequire(import.meta.resolve("openclaw/plugin-sdk/plugin-entry"));
const mockRequire = createRequire(import.meta.resolve("@alignfirst/openclaw-channel-mock-core"));

test("packed mock and actual host resolve one shared Zod instance", () => {
  assert.equal(realpathSync(mockRequire.resolve("zod")), realpathSync(hostRequire.resolve("zod")));
  assert.match(
    realpathSync(fileURLToPath(import.meta.resolve("@alignfirst/openclaw-channel-mock-core"))),
    /\/node_modules\/@alignfirst\/openclaw-channel-mock-core\/dist\/index\.js$/u,
  );
});

for (const surface of ["slack", "discord"] as const) {
  test(`packed ${surface} factory composes host and local schemas without runtime startup`, () => {
    const schema = createChannelMockPlugin({
      channelId: `${surface}-mock`,
      label: `${surface} mock`,
      surface,
      autoThread: surface === "slack",
      getRuntime: () => {
        throw new Error("Schema construction must not start a runtime");
      },
    }).configSchema;
    const config = {
      baseUrl: "http://localhost:43123",
      pollTimeoutMs: 100,
      groups: {
        general: {
          requireMention: false,
          tools: { allow: ["message"], deny: ["exec"] },
          toolsBySender: { "user:robin": { allow: ["read"] } },
        },
      },
      accounts: { test: { enabled: true, pollTimeoutMs: 30_000, replyToMode: "all" } },
    };
    assert.deepEqual(schema?.runtime?.safeParse?.(config), { success: true, data: config });
    for (const invalid of [
      { baseUrl: "invalid" },
      { pollTimeoutMs: 99 },
      { unknown: true },
      { accounts: { test: { unknown: true } } },
      { groups: { general: { toolsBySender: { robin: { allow: "exec" } } } } },
    ]) {
      assert.equal(schema?.runtime?.safeParse?.(invalid).success, false);
    }
    assert.equal(schema?.schema.type, "object");
    assert.equal(schema?.schema.additionalProperties, false);
    assert.match(JSON.stringify(schema?.schema), /"toolsBySender"/u);
    assert.match(JSON.stringify(schema?.schema), /"maximum":30000/u);
  });
}
