import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const sharedCliArtifacts = [
  "packages/docmap/dist/cli.js",
  "packages/docmap/dist/invocation.js",
  "packages/workspace/dist/index.js",
  "packages/workspace/dist/git.js",
  "packages/workspace/dist/config.js",
  "packages/alignfirst/dist/cli.js",
];

/**
 * @param {string[]} entries
 * @param {string} [remedy]
 */
export function requireBuiltArtifacts(entries, remedy) {
  const missing = entries.map((entry) => resolve(repositoryRoot, entry)).filter(isMissingFile);
  if (missing.length === 0) return;
  throw new Error(
    `Integration prerequisites are missing or not files:\n${missing.map((path) => `  ${path}`).join("\n")}\n` +
      "Run `npm run build` from the repository root before integration tests, including filtered runs.\n" +
      (remedy ?? "Preflight checks provisioning only; rebuild after source changes."),
  );
}

function isMissingFile(path) {
  try {
    return !statSync(path).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return true;
    throw error;
  }
}
