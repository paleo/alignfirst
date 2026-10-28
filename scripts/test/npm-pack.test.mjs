import assert from "node:assert/strict";
import { test } from "node:test";
import { readPackedFilename } from "../npm-pack.mjs";

test("pack consumers accept npm 11 array and npm 12 keyed output", () => {
  for (const packed of [
    [{ name: "alignfirst", filename: "alignfirst-0.15.0.tgz" }],
    { alignfirst: { name: "alignfirst", filename: "alignfirst-0.15.0.tgz" } },
  ])
    assert.equal(readPackedFilename(packed), "alignfirst-0.15.0.tgz");
});

test("pack consumers reject absent filenames instead of installing a registry fallback", () => {
  assert.throws(() => readPackedFilename({ alignfirst: {} }), /no filename/);
});
