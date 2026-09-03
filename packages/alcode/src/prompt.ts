export const PROTOCOLS = [
  "spec",
  "plan",
  "aad",
  "description",
  "catchup",
  "review",
  "merge",
] as const;

export type Protocol = (typeof PROTOCOLS)[number];

export interface PromptInput {
  protocol?: string;
  ticket?: string;
  message?: string;
}

export function buildPrompt(input: PromptInput): string {
  const { protocol, ticket, message } = input;
  if (protocol === undefined) return message ?? "";
  return buildProtocolPrompt(protocol, ticket, message);
}

function buildProtocolPrompt(protocol: string, ticket?: string, message?: string): string {
  const ticketPart = ticket === undefined ? "" : ` Ticket ID = ${ticket}.`;
  const messagePart = message === undefined ? "" : `\n\n${message}`;
  return `Run \`alignfirst guide ${protocol}\` and follow the protocol.${ticketPart}${messagePart}`;
}
