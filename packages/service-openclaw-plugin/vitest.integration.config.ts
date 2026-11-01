import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { repositoryRoot, requireBuiltArtifacts } from "../../scripts/test/built-artifacts.mjs";

const packedRoot = process.env.THREAD_HANDOFF_PACKED_ROOT;
const fixtureRoot = resolve(packedRoot ?? repositoryRoot);
const packageDirectory = packedRoot === undefined ? "packages" : "node_modules/@alignfirst";
const pluginEntries = ["package.json", "openclaw.plugin.json", "dist/index.js"];
const channelEntries = [
  ...pluginEntries,
  ...["setup-entry", "channel-plugin-api", "channel-setup-plugin", "runtime"].map(
    (name) => `dist/${name}.js`,
  ),
];

requireBuiltArtifacts(
  [
    "packages/openclaw-channel-mock-core/dist/index.js",
    ...["node_modules/.bin/openclaw", "node_modules/openclaw/openclaw.mjs"].map((entry) =>
      resolve(fixtureRoot, entry),
    ),
    ...pluginEntries.map((entry) =>
      resolve(fixtureRoot, packageDirectory, "service-openclaw-plugin", entry),
    ),
    ...["openclaw-discord-mock", "openclaw-slack-mock"].flatMap((name) =>
      channelEntries.map((entry) => resolve(fixtureRoot, packageDirectory, name, entry)),
    ),
    ...(packedRoot === undefined
      ? []
      : [resolve(fixtureRoot, packageDirectory, "openclaw-channel-mock-core/dist/index.js")]),
  ],
  packedRoot === undefined
    ? undefined
    : `Packed provisioning is incomplete at ${fixtureRoot}. Install the built packages and OpenClaw in that consumer; the root build does not install a standalone consumer.`,
);

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
