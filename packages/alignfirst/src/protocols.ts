export const PROTOCOLS = [
  "spec",
  "plan",
  "aad",
  "catchup",
  "merge",
  "review",
  "description",
] as const;

export type Protocol = (typeof PROTOCOLS)[number];
