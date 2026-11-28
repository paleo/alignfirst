import assert from "node:assert/strict";
import { test } from "node:test";
import {
  invokesAligndevCode,
  invokesCodingAgentDirectly,
  readsAssistantInstructions,
} from "../scenarios/_lib/agent-tool-calls.ts";

const AGENTS = [
  { agent: "claude", launch: "claude -p prompt" },
  { agent: "codex", launch: "codex exec prompt" },
  { agent: "pi", launch: "pi --mode json" },
];

test("instruction observation follows the command and selected worktree, not a filename read", () => {
  const call = { toolName: "exec", toolUseId: "instructions" };
  for (const input of [
    { command: "alignfirst assistant-instructions", workdir: "/projects/nimbus/src" },
    { command: "cd /projects/nimbus && npx -y alignfirst assistant-instructions" },
    { command: "alignfirst developer-instructions", workdir: "/projects/nimbus" },
  ]) {
    assert.equal(readsAssistantInstructions({ ...call, input }, "/projects/nimbus"), true);
  }
  for (const input of [
    { command: "cat ASSISTANTS.md", workdir: "/projects/nimbus" },
    { command: "alignfirst assistant-instructions", workdir: "/projects/nimbus-other" },
  ]) {
    assert.equal(readsAssistantInstructions({ ...call, input }, "/projects/nimbus"), false);
  }
});

test("detects direct native-agent bypasses", () => {
  for (const { agent } of AGENTS) {
    for (const command of [
      `${agent} --mode json`,
      `/usr/local/bin/${agent} prompt`,
      `'${agent}' --mode json`,
      `"/usr/local/bin/${agent}" prompt`,
      `cd /fixture && ${agent} prompt`,
      `env HOME=/fixture ${agent} prompt`,
      `npx -y ${agent} prompt`,
      `command ${agent} prompt`,
      `HOME=/fixture exec ${agent} prompt`,
      `(aligndev code status; ${agent} prompt)`,
      `aligndev guide code && ${agent} prompt`,
      `env HOME='/fixture; path' command ${agent} prompt`,
      `echo ignored # comment; not a launch\n${agent} --mode json`,
      `${agent}\\\n --mode json`,
    ]) {
      assert.equal(invokesCodingAgentDirectly(exec(command)), true, command);
    }
  }
});

test("distinguishes quoted syntax from chained launches", () => {
  for (const { agent } of AGENTS) {
    for (const separator of [";", "\n", "&", "&&", "|", "||", "("]) {
      for (const quote of ["'", '"']) {
        const delegation =
          "aligndev code new --protocol review --ticket ABC-1 --message " +
          `${quote}Review APIs${separator} ${agent} --mode json is relevant${quote}`;
        assert.equal(invokesAligndevCode(exec(delegation)), true, delegation);
        assert.equal(invokesCodingAgentDirectly(exec(delegation)), false, delegation);
        for (const boundary of [";", "\n", "&", "&&", "|", "||"]) {
          const command = `${delegation}${boundary}${agent} --mode json`;
          assert.equal(invokesCodingAgentDirectly(exec(command)), true, command);
        }
      }
    }
  }
});

test("ignores escaped syntax and non-command words", () => {
  for (const { agent } of AGENTS) {
    for (const command of [
      `aligndev code new --message "Review \\"APIs; ${agent} --mode json\\""`,
      `aligndev code new --message 'Review APIs'\\''; ${agent} --mode json'`,
      `aligndev code new --message Review\\;\\ ${agent}\\ --mode\\ json`,
      `printf '%s' 'Review APIs; ${agent} --mode json'`,
      `printf '%s' "Review APIs\\n; ${agent} --mode json"`,
      `echo done # example; ${agent} --mode json`,
      `printf '%s' example\\\n${agent}`,
    ]) {
      assert.equal(invokesCodingAgentDirectly(exec(command)), false, command);
    }
  }
});

test("detects executable command substitutions", () => {
  for (const { launch } of AGENTS) {
    for (const substitution of [`$(${launch})`, `\`${launch}\``]) {
      for (const command of [
        `echo ${substitution}`,
        `echo "${substitution}"`,
        `aligndev code new --message "Review ${substitution}"`,
        `echo "$(printf '%s' "${substitution}")"`,
      ]) {
        assert.equal(invokesCodingAgentDirectly(exec(command)), true, command);
      }
    }
  }
});

test("ignores single-quoted substitutions", () => {
  for (const { launch } of AGENTS) {
    for (const command of [`echo '$(${launch})'`, `echo '\`${launch}\`'`]) {
      assert.equal(invokesCodingAgentDirectly(exec(command)), false, command);
    }
  }
});

test("tracks quotes and nesting inside substitutions", () => {
  for (const { launch } of AGENTS) {
    for (const command of [
      `echo "$(printf '%s' ')'; ${launch})"`,
      `echo "$(printf '%s' "a ) character"; ${launch})"`,
      `echo "$( (echo ignored); ${launch})"`,
      `echo "\`printf '%s' ')'; ${launch}\`"`,
    ]) {
      assert.equal(invokesCodingAgentDirectly(exec(command)), true, command);
    }
  }
});

test("ignores literal syntax in substitutions", () => {
  for (const { agent, launch } of AGENTS) {
    for (const command of [
      `echo "\\$(${launch})"`,
      `echo \\$\\(${launch}\\)`,
      `echo "\\\`${launch}\\\`"`,
      `echo \\\`${launch}\\\``,
      `echo "$(printf '%s' '; ${launch}')"`,
      `echo "$(printf '%s' "; ${launch}")"`,
      `echo "\`printf '%s' '; ${launch}'\`"`,
      `echo "$(printf '%s' '$(${launch})')"`,
      `echo "$(printf '%s' \\; ${agent})"`,
    ]) {
      assert.equal(invokesCodingAgentDirectly(exec(command)), false, command);
    }
  }
});

test("accepts wrapper delegation without native bypass", () => {
  for (const command of [
    "aligndev code new --message 'Inspect the files'",
    "(aligndev code resume session-id; openclaw system event --mode now)",
    "npx -y aligndev code new --model vendor/alpha",
    "aligndev code new --profile pi --message 'Compare claude codex pi behavior'",
    "aligndev code new --message 'Inspect pi configuration'",
  ]) {
    assert.equal(invokesAligndevCode(exec(command)), true, command);
    assert.equal(invokesCodingAgentDirectly(exec(command)), false, command);
  }
});

test("ignores non-launch commands", () => {
  for (const command of [
    "aligndev guide code",
    "aligndev code status",
    "pipeline --help",
    "printenv PI_MODEL",
  ]) {
    assert.equal(invokesAligndevCode(exec(command)), false, command);
    assert.equal(invokesCodingAgentDirectly(exec(command)), false, command);
    assert.equal(invokesCodingAgentDirectly({ ...exec(command), toolName: "read" }), false);
  }
});

function exec(command: string) {
  return { toolName: "exec", toolUseId: "test", input: { command } };
}
