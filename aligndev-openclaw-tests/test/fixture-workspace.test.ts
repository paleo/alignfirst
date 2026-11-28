import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_PORT_BOUNDS,
  FIXTURE_PORT_RANGES,
  fixturePortRange,
  patchDevServerRange,
} from "../scripts/fixture-personalization.ts";
import { lowestFreeFixtureBlock } from "../scenarios/_lib/free-port-block.ts";

const template = fileURLToPath(new URL("../projects-fixture/template", import.meta.url));
const source = readFileSync(join(template, "alignfirst.json"), "utf8");
const a12Block = lowestFreeFixtureBlock(8);

test("A12 block is the lowest block within the fixture bounds that overlaps no fixture", () => {
  const fixtures = Object.values(FIXTURE_PORT_RANGES);
  const overlapsFixture = (first: number, last: number) =>
    fixtures.some((range) => range.first <= last && first <= range.last);
  assert.equal(a12Block.last - a12Block.first, 7);
  assert(a12Block.first >= FIXTURE_PORT_BOUNDS.first && a12Block.last <= FIXTURE_PORT_BOUNDS.last);
  assert.equal(overlapsFixture(a12Block.first, a12Block.last), false);
  for (let first = FIXTURE_PORT_BOUNDS.first; first < a12Block.first; ++first) {
    assert(overlapsFixture(first, first + 7), `block at ${first} is free`);
  }
});

test("fixture and A12 port blocks patch strictly and idempotently", () => {
  for (const { first, last } of [...Object.values(FIXTURE_PORT_RANGES), a12Block]) {
    const patched = patchDevServerRange(source, first, last);
    assert.equal(JSON.parse(patched).devServer.ports.first, first);
    assert.equal(JSON.parse(patched).devServer.ports.last, last);
    assert.equal(patchDevServerRange(patched, first, last), patched);
    assert.deepEqual(fixturePortRange(first, last), { first, last });
  }
  for (const malformed of [
    source.replace('"first": 6500', '"base": 6500'),
    source.replace('"last": 6519,', ""),
    source.replace('["frontend"]', '["other"]'),
  ]) {
    assert.throws(() => patchDevServerRange(malformed, a12Block.first, a12Block.last));
  }
  for (const [first, last] of [
    [0, 1],
    [1, 65536],
    [6500, 6499],
    [6500.5, 6519],
  ]) {
    assert.throws(() => fixturePortRange(first, last));
  }
});
