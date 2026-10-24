import {
  type Invocation,
  type InvocationCommand,
  type LaunchEvidence,
  invocationCommand,
  packageCommand,
  readLaunchEvidence,
  resolveInvocation,
} from "@alignfirst/docmap/invocation";

export interface CommandForms {
  invocation: Invocation;
  self: InvocationCommand;
  counterpart: InvocationCommand;
  aligndev: string;
  alignfirst: string;
}

export function resolveCommandForms(
  env: NodeJS.ProcessEnv,
  evidence: LaunchEvidence = { ...readLaunchEvidence(), env },
): CommandForms {
  const invocation = resolveInvocation(
    { packageName: "aligndev", binaryName: "aligndev" },
    evidence,
  );
  const self = invocationCommand(invocation);
  const counterpart = packageCommand(invocation, {
    packageName: "alignfirst",
    binaryName: "alignfirst",
  });
  return {
    invocation,
    self,
    counterpart,
    aligndev: self.withArgs,
    alignfirst: counterpart.withArgs,
  };
}
