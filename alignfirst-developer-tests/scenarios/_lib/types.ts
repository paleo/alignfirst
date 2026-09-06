import type { OutboundReceivedEntry } from "@paleo/openclaw-test";

export interface Step {
  match: { id: string; text: string; threadId?: string };
  entry: OutboundReceivedEntry;
  threadId: string;
  nextCursor: number;
  sourceSessionKey?: string;
  targetSessionKey?: string;
}
