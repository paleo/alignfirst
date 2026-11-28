import type { CodeConfig } from "../config.js";
import { CONFIG_DIRECTORY_VARIABLES } from "./harness-environment.js";
import { escapeControlCharacters } from "../project/format.js";
import { CODING_AGENT_NAMES, type CodingAgent } from "./coding-agent.js";
import { describeProfile } from "./native-context.js";
import type { AuthenticationFailure } from "./run-agent.js";

// A word the shell refuses to expand: the command fails until the value replaces it.
const OMITTED_VALUE = `"\${OMITTED:?replace it with the settings value}"`;

export function renderAuthenticationFailure(code: CodeConfig, cwd: string): AuthenticationFailure {
  const name = CODING_AGENT_NAMES[code.harness];
  return {
    instructions:
      `Coding agent not authenticated: ${describeProfile(code)}. ` +
      `Do not retry until ${name} is authenticated:\n\n` +
      renderLoginInstructions(code, cwd),
    errorLabel: `Error reported by ${name}:`,
  };
}

/**
 * The login command under the agent's native configuration, run from the agent's directory.
 * It prints `configDir` and the directory paths the agent inherited, never a profile `env` value.
 */
export function renderLoginInstructions(code: CodeConfig, cwd: string): string {
  const { removals, assignments, omitted } = nativeEnvironment(code);
  const command = [
    ...(removals.length + assignments.length === 0 ? [] : ["env"]),
    ...removals.map((name) => `-u ${name}`),
    ...assignments,
    loginCommand(code.harness),
  ].join(" ");
  return [
    `  cd ${quoteShell(cwd)} && ${command}`,
    "",
    ...loginStep(code.harness),
    ...(omitted ? [omittedValuesNote(code)] : []),
    `Run the command as the agent's OS user${inheritedHome(code)}. The agent inherits the rest of its environment from the assistant's session: a login from another account or shell may select another account.`,
  ].join("\n");
}

interface NativeEnvironment {
  removals: string[];
  // `NAME=value` shell words.
  assignments: string[];
  omitted: boolean;
}

// What the profile changes in the agent's environment, and the native directory variable the
// agent ran with, since another shell may hold a different one.
function nativeEnvironment(code: CodeConfig): NativeEnvironment {
  const directory = CONFIG_DIRECTORY_VARIABLES[code.harness];
  const profileEnv = Object.keys(code.env ?? {});
  const removals = new Set(code.unset);
  const assignments: string[] = [];
  let omitted = false;
  for (const name of new Set([...(directory === undefined ? [] : [directory]), ...profileEnv])) {
    const value = code.childEnv[name];
    if (value === undefined) {
      removals.add(name);
      continue;
    }
    const fromProfile = profileEnv.includes(name);
    omitted ||= fromProfile;
    assignments.push(`${name}=${fromProfile ? OMITTED_VALUE : quoteShell(value)}`);
  }
  return { removals: [...removals], assignments, omitted };
}

function quoteShell(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  if (escapeControlCharacters(value) === value) return `'${value.replaceAll("'", "'\\''")}'`;
  // ANSI-C quoting keeps a control character on the command's line.
  return `$'${Array.from(value, escapeAnsiC).join("")}'`;
}

// A control character becomes its UTF-8 bytes: `\u` only decodes under a UTF-8 locale.
function escapeAnsiC(character: string): string {
  if (character === "\\" || character === "'") return `\\${character}`;
  if (escapeControlCharacters(character) === character) return character;
  return Array.from(
    Buffer.from(character),
    (byte) => `\\x${byte.toString(16).padStart(2, "0")}`,
  ).join("");
}

function loginCommand(harness: CodingAgent): string {
  return harness === "codex" ? "codex login" : harness;
}

// What follows the command; `codex login` is the whole login.
function loginStep(harness: CodingAgent): string[] {
  switch (harness) {
    case "claude":
      return ["Then run `/login` in Claude Code."];
    case "codex":
      return [];
    case "pi":
      return [
        "Then run `/login <provider>` in Pi, or configure the provider's credentials in this environment.",
      ];
    case "agy":
      return ["Then sign in to Antigravity, which keeps one account per OS user."];
  }
}

function omittedValuesNote(code: CodeConfig): string {
  return `Replace each \`${OMITTED_VALUE}\` with the value in \`code.profiles[${JSON.stringify(code.profile)}].env\` of \`~/.alignfirst/aligndev.settings.json\`. The shell refuses the command until then.`;
}

function inheritedHome(code: CodeConfig): string {
  const home = code.childEnv.HOME;
  if (home === undefined || Object.hasOwn(code.env ?? {}, "HOME")) return "";
  return ` (HOME \`${escapeControlCharacters(home)}\`)`;
}
