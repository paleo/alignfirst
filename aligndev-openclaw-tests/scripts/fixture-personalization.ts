export function patchDevServerRange(source: string, first: number, last: number): string {
  const range = fixturePortRange(first, last);
  const fields = [
    [/^ {2}ports: \{$/gm, "ports"],
    [/^ {4}first: \d+,$/gm, "first"],
    [/^ {4}last: \d+,$/gm, "last"],
    [/^ {4}declare: \["frontend"\],$/gm, "declare"],
  ] as const;
  for (const [pattern, field] of fields) {
    if ([...source.matchAll(pattern)].length !== 1) {
      throw new Error(`Expected exactly one fixture dev-server ${field} field.`);
    }
  }
  return source
    .replace(/^ {4}first: \d+,$/m, `    first: ${range.first},`)
    .replace(/^ {4}last: \d+,$/m, `    last: ${range.last},`);
}

export function fixturePortRange(first: number, last: number): { first: number; last: number } {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 1 ||
    last > 65535 ||
    last < first
  ) {
    throw new Error(`Invalid fixture port range: ${first}..${last}`);
  }
  return { first, last };
}
