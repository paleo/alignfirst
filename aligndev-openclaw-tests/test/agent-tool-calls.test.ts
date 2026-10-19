import assert from "node:assert/strict";
import { test } from "node:test";
import {
  invokesAligndevCode,
  invokesCodingAgentDirectly,
} from "../scenarios/_lib/agent-tool-calls.ts";

for (const agent of ["claude", "codex", "pi"]) {
  for (const command of [
    `${agent} --mode json`,
    `/usr/local/bin/${agent} prompt`,
    `cd /fixture && ${agent} prompt`,
    `env HOME=/fixture ${agent} prompt`,
    `npx -y ${agent} prompt`,
    `command ${agent} prompt`,
    `HOME=/fixture exec ${agent} prompt`,
    `(aligndev code status; ${agent} prompt)`,
    `aligndev guide code && ${agent} prompt`,
  ]) {
    test(`detects direct native-agent bypass: ${command}`, () => {
      assert.equal(
        invokesCodingAgentDirectly({
          toolName: "exec",
          toolUseId: "test",
          input: { command },
        }),
        true,
      );
    });
  }
}

for (const command of [
  "aligndev code new --message 'Inspect the files'",
  "(aligndev code resume session-id; openclaw system event --mode now)",
  "npx -y aligndev code new --model openai/gpt-5.6-terra",
  "aligndev code new --profile pi --message 'Compare claude codex pi behavior'",
  "aligndev code new --message 'Inspect pi configuration'",
]) {
  test(`accepts wrapper delegation without native bypass: ${command}`, () => {
    const call = { toolName: "exec", toolUseId: "test", input: { command } };
    assert.equal(invokesAligndevCode(call), true);
    assert.equal(invokesCodingAgentDirectly(call), false);
  });
}

for (const command of [
  "aligndev guide code",
  "aligndev code status",
  "pipeline --help",
  "printenv PI_MODEL",
]) {
  test(`ignores non-launch commands: ${command}`, () => {
    const call = { toolName: "exec", toolUseId: "test", input: { command } };
    assert.equal(invokesAligndevCode(call), false);
    assert.equal(invokesCodingAgentDirectly(call), false);
    assert.equal(invokesCodingAgentDirectly({ ...call, toolName: "read" }), false);
  });
}
