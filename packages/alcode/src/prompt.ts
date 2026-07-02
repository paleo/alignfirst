export const PROTOCOLS = ["spec", "plan", "aad", "description", "read", "review", "merge"] as const;

export type Protocol = (typeof PROTOCOLS)[number];

export const PROTOCOL_LABELS: Record<string, string> = {
  spec: "spec",
  aad: "AAD",
  plan: "plan",
  description: "description",
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
  if (protocol === "read") return buildReadPrompt(ticket, message);
  return buildProtocolPrompt(PROTOCOL_LABELS[protocol], ticket, message);
}

function buildReadPrompt(ticket?: string, message?: string): string {
  const ticketPart = ticket ? ` for ticket ${ticket}` : "";
  const messagePart = message ? `\n\n${message}` : "";
  return `Use the *alignfirst* skill to determine the TASK_DIR${ticketPart}. Then read every \`*spec.md\` and \`*summary.md\` file in the TASK_DIR.${messagePart}`;
}

function buildProtocolPrompt(label: string, ticket?: string, message?: string): string {
  const ticketPart = ticket ? ` Ticket ID = ${ticket}.` : "";
  const messagePart = message ? `\n\n${message}` : "";
  return `Run the _${label}_ protocol from the *alignfirst* skill.${ticketPart}${messagePart}`;
}
