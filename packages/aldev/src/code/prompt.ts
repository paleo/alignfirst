export const PROTOCOLS = ["spec", "plan", "aad", "description", "review", "merge"] as const;

export type Protocol = (typeof PROTOCOLS)[number];

export interface PromptInput {
  protocol?: string;
  ticket?: string;
  message?: string;
  catchupContent?: string;
}

export function buildPrompt(input: PromptInput): string {
  const { protocol, ticket, message } = input;
  const instruction =
    protocol === undefined ? message : buildProtocolPrompt(protocol, ticket, message);
  if (input.catchupContent === undefined) return instruction ?? "";
  return [
    "## Ticket history",
    input.catchupContent,
    "## Current instruction",
    instruction === undefined || instruction.trim() === ""
      ? "Summarize the ticket history briefly, including what remains unfinished."
      : instruction,
  ].join("\n\n");
}

function buildProtocolPrompt(protocol: string, ticket?: string, message?: string): string {
  const ticketPart = ticket === undefined ? "" : ` Ticket ID = ${ticket}.`;
  const messagePart = message === undefined ? "" : `\n\n${message}`;
  return `Run \`alignfirst guide ${protocol}\` and follow the protocol.${ticketPart}${messagePart}`;
}
