// The bounds that `workspace/AGENTS.md` states and the assistant passes to `free-ports --within`.
export const FIXTURE_PORT_BOUNDS: PortRange = { first: 6500, last: 7700 };

// Each fixture and its linked worktrees share a dedicated 20-port block.
export const FIXTURE_PORT_RANGES = {
  nimbus: { first: 6500, last: 6519 },
  lumen: { first: 6520, last: 6539 },
  orion: { first: 6540, last: 6559 },
} as const;

export interface PortRange {
  first: number;
  last: number;
}

export function patchDevServerRange(source: string, first: number, last: number): string {
  const range = fixturePortRange(first, last);
  const manifest = JSON.parse(source);
  const ports = manifest.devServer?.ports;
  if (
    manifest.schemaVersion !== 1 ||
    ports === undefined ||
    !Number.isInteger(ports.first) ||
    !Number.isInteger(ports.last) ||
    JSON.stringify(ports.declare) !== '["frontend"]'
  ) {
    throw new Error("Expected fixture manifest with frontend port declaration.");
  }
  Object.assign(ports, range);
  return `${JSON.stringify(manifest, null, 2)}\n`;
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
