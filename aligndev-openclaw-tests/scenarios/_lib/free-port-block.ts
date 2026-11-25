import {
  FIXTURE_PORT_BOUNDS,
  FIXTURE_PORT_RANGES,
  type PortRange,
} from "../../scripts/fixture-personalization.ts";

/** The block `free-ports --size <size> --within` the fixture bounds returns on a freshly reset fixture. */
export function lowestFreeFixtureBlock(size: number): PortRange {
  const claimed = Object.values(FIXTURE_PORT_RANGES);
  let first = FIXTURE_PORT_BOUNDS.first;
  while (first + size - 1 <= FIXTURE_PORT_BOUNDS.last) {
    const last = first + size - 1;
    const overlap = claimed.find((range) => range.first <= last && first <= range.last);
    if (overlap === undefined) return { first, last };
    first = overlap.last + 1;
  }
  throw new Error(`no block of ${size} free ports in the fixture bounds`);
}
