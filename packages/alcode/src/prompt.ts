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

export const PROTOCOL_LABELS: Record<string, string> = {
  spec: "spec",
  aad: "AAD",
  plan: "plan",
  description: "description",
  catchup: "catchup",
  review: "review",
  merge: "merge",
};

export interface PromptInput {
  protocol?: string;
  ticket?: string;
  message?: string;
}

export function buildPrompt(input: PromptInput): string {
  const { protocol, ticket, message } = input;
  if (!protocol) return message ?? "";
  return buildProtocolPrompt(PROTOCOL_LABELS[protocol], ticket, message);
}

function buildProtocolPrompt(label: string, ticket?: string, message?: string): string {
  const ticketPart = ticket ? ` Ticket ID = ${ticket}.` : "";
  const messagePart = message ? `\n\n${message}` : "";
  return `Run the _${label}_ protocol from the *alignfirst* skill.${ticketPart}${messagePart}`;
}
