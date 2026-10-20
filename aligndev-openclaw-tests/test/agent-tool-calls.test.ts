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

for (const agent of ["claude", "codex", "pi"]) {
  for (const separator of [";", "\n", "&", "&&", "|", "||", "("]) {
    for (const quote of ["'", '"']) {
      const delegation =
        "aligndev code new --protocol review --ticket ABC-1 --message " +
        `${quote}Review APIs${separator} ${agent} --mode json is relevant${quote}`;
      test(`distinguishes quoted syntax from chained launches: ${JSON.stringify(delegation)}`, () => {
        const call = { toolName: "exec", toolUseId: "test", input: { command: delegation } };
        assert.equal(invokesAligndevCode(call), true);
        assert.equal(invokesCodingAgentDirectly(call), false);

        for (const boundary of [";", "\n", "&", "&&", "|", "||"]) {
          const command = `${delegation}${boundary}${agent} --mode json`;
          assert.equal(
            invokesCodingAgentDirectly({ ...call, input: { command } }),
            true,
            `detects real launch: ${JSON.stringify(command)}`,
          );
        }
      });
    }
  }

  for (const command of [
    `aligndev code new --message "Review \\"APIs; ${agent} --mode json\\""`,
    `aligndev code new --message 'Review APIs'\\''; ${agent} --mode json'`,
    `aligndev code new --message Review\\;\\ ${agent}\\ --mode\\ json`,
    `printf '%s' 'Review APIs; ${agent} --mode json'`,
    `printf '%s' "Review APIs\\n; ${agent} --mode json"`,
    `echo done # example; ${agent} --mode json`,
    `printf '%s' example\\\n${agent}`,
  ]) {
    test(`ignores escaped syntax and non-command words: ${JSON.stringify(command)}`, () => {
      const call = { toolName: "exec", toolUseId: "test", input: { command } };
      assert.equal(invokesCodingAgentDirectly(call), false);
    });
  }
}

for (const [agent, args] of [
  ["pi", "--mode json"],
  ["codex", "exec prompt"],
  ["claude", "-p prompt"],
]) {
  const launch = `${agent} ${args}`;
  for (const substitution of [`$(${launch})`, `\`${launch}\``]) {
    for (const command of [
      `echo ${substitution}`,
      `echo "${substitution}"`,
      `aligndev code new --message "Review ${substitution}"`,
      `echo "$(printf '%s' "${substitution}")"`,
    ]) {
      test(`detects executable command substitutions: ${JSON.stringify(command)}`, () => {
        const call = { toolName: "exec", toolUseId: "test", input: { command } };
        assert.equal(invokesCodingAgentDirectly(call), true);
      });
    }

    const command = `echo '${substitution}'`;
    test(`ignores single-quoted substitutions: ${JSON.stringify(command)}`, () => {
      const call = { toolName: "exec", toolUseId: "test", input: { command } };
      assert.equal(invokesCodingAgentDirectly(call), false);
    });
  }

  for (const command of [
    `echo "$(printf '%s' ')'; ${launch})"`,
    `echo "$(printf '%s' "a ) character"; ${launch})"`,
    `echo "$( (echo ignored); ${launch})"`,
    `echo "\`printf '%s' ')'; ${launch}\`"`,
  ]) {
    test(`tracks quotes and nesting inside substitutions: ${JSON.stringify(command)}`, () => {
      const call = { toolName: "exec", toolUseId: "test", input: { command } };
      assert.equal(invokesCodingAgentDirectly(call), true);
    });
  }

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
    test(`ignores literal syntax in substitutions: ${JSON.stringify(command)}`, () => {
      const call = { toolName: "exec", toolUseId: "test", input: { command } };
      assert.equal(invokesCodingAgentDirectly(call), false);
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
