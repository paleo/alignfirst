export const PROTOCOLS = ["spec", "plan", "aad", "description", "review", "merge"] as const;

export type Protocol = (typeof PROTOCOLS)[number];

export interface PromptInput {
  protocol?: string;
  ticket?: string;
  message?: string;
  catchupContent?: string;
  contextContent?: string;
}

export function buildPrompt(input: PromptInput): string {
  const { protocol, ticket, message, catchupContent, contextContent } = input;
  const instruction =
    protocol === undefined ? message : buildProtocolPrompt(protocol, ticket, message);
  if (catchupContent === undefined && contextContent === undefined) return instruction ?? "";
  const sections: string[] = [];
  if (contextContent !== undefined) sections.push("## Project context", contextContent.trimEnd());
  if (catchupContent !== undefined) sections.push("## Ticket history", catchupContent);
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

function buildProtocolPrompt(protocol: string, ticket?: string, message?: string): string {
  const ticketPart = ticket === undefined ? "" : ` Ticket ID = ${ticket}.`;
  const messagePart = message === undefined ? "" : `\n\n${message}`;
  return `Run \`alignfirst guide ${protocol}\` and follow the protocol.${ticketPart}${messagePart}`;
}
