import { type PortRange, SETTINGS_PORT_RANGE } from "../../scripts/coding-agent-settings.ts";
import { FIXTURE_PORT_RANGES } from "../../scripts/fixture-personalization.ts";

/** The block `aligndev project free-ports --size <size>` returns on a freshly reset fixture. */
export function lowestFreeFixtureBlock(size: number): PortRange {
  const claimed = Object.values(FIXTURE_PORT_RANGES);
  let first = SETTINGS_PORT_RANGE.first;
  while (first + size - 1 <= SETTINGS_PORT_RANGE.last) {
    const last = first + size - 1;
    const overlap = claimed.find((range) => range.first <= last && first <= range.last);
    if (overlap === undefined) return { first, last };
    first = overlap.last + 1;
  }
  throw new Error(`no block of ${size} free ports in the fixture settings range`);
}
