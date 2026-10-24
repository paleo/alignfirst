import {
  invocationCommand,
  type Invocation,
  readLaunchEvidence,
  resolveInvocation,
} from "@alignfirst/docmap/invocation";

export function resolveCliInvocation(): Invocation {
  return resolveInvocation(
    { packageName: "@alignfirst/openclaw-test", binaryName: "openclaw-test" },
    readLaunchEvidence(),
  );
}

export function cliCommand(invocation: Invocation): string {
  return invocationCommand(invocation).withArgs;
}
