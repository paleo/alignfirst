export const PROTOCOLS = ["spec", "plan", "aad", "description", "review", "merge"] as const;

// Opens every new session. Codex kills its subagents when its turn ends; Claude waits for them.
export const RUN_CONTEXT =
  "You run non-interactively. When your turn ends, the process exits and kills every subagent " +
  "and background command still running. Before ending your turn, wait for each one you started " +
  "and check its result.";

export type Protocol = (typeof PROTOCOLS)[number];

export interface PromptInput {
  protocol?: string;
  ticket?: string;
  message?: string;
  // A resumed session already holds the run context from its first prompt.
  newSession: boolean;
  catchupContent?: string;
  contextContent?: string;
  // The alignfirst command form, e.g. `alignfirst` or `npx -y alignfirst`.
  alignfirst: string;
}

export function buildPrompt(input: PromptInput): string {
  const { protocol, ticket, message, newSession, catchupContent, contextContent, alignfirst } =
    input;
  const instruction =
    protocol === undefined ? message : buildProtocolPrompt(alignfirst, protocol, ticket, message);
  const sections: string[] = [];
  if (newSession) sections.push("## Run context", RUN_CONTEXT);
  if (contextContent !== undefined) sections.push("## Project context", contextContent.trimEnd());
  if (catchupContent !== undefined) sections.push("## Ticket history", catchupContent);
  if (sections.length === 0) return instruction ?? "";
  sections.push("## Current instruction", currentInstruction(instruction, catchupContent));
  return sections.join("\n\n");
}

function currentInstruction(
  instruction: string | undefined,
  catchupContent: string | undefined,
): string {
  const blank = instruction === undefined || instruction.trim() === "";
  if (blank && catchupContent !== undefined) {
    return "Summarize the ticket history briefly, including what remains unfinished.";
  }
  return instruction ?? "";
}

function buildProtocolPrompt(
  alignfirst: string,
  protocol: string,
  ticket?: string,
  message?: string,
): string {
  const ticketPart = ticket === undefined ? "" : ` Ticket ID = ${ticket}.`;
  const messagePart = message === undefined ? "" : `\n\n${message}`;
  return `Run \`${alignfirst} guide ${protocol}\` and follow the protocol.${ticketPart}${messagePart}`;
}
