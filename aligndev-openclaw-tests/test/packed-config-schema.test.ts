import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hostRequire = createRequire(import.meta.resolve("openclaw/plugin-sdk/plugin-entry"));
const mockRequire = createRequire(import.meta.resolve("@alignfirst/openclaw-channel-mock-core"));

test("packed mock and actual host resolve one shared Zod instance", () => {
  assert.equal(realpathSync(mockRequire.resolve("zod")), realpathSync(hostRequire.resolve("zod")));
  assert.match(
    realpathSync(fileURLToPath(import.meta.resolve("@alignfirst/openclaw-channel-mock-core"))),
    /\/node_modules\/@alignfirst\/openclaw-channel-mock-core\/dist\/index\.js$/u,
  );
});
