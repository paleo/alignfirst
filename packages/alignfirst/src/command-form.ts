import {
  type LaunchEvidence,
  invocationCommand,
  readLaunchEvidence,
  resolveInvocation,
} from "@alignfirst/docmap/invocation";

export const CMD_PLACEHOLDER = "{{CMD}}";

export function resolveCommandForm(
  env: NodeJS.ProcessEnv,
  evidence: LaunchEvidence = { ...readLaunchEvidence(), env },
): string {
  return invocationCommand(
    resolveInvocation({ packageName: "alignfirst", binaryName: "alignfirst" }, evidence),
  ).withArgs;
}

export function renderCommandForm(text: string, form: string): string {
  return text.replaceAll(CMD_PLACEHOLDER, () => form);
}
