import assert from "node:assert/strict";
import test from "node:test";
import { listComparables, listRegions } from "./comparables.mjs";
import { toCsv } from "./export-handler.mjs";
import { renderHomePage } from "./home-page.mjs";

test("the home page names the branch", () => {
  assert.match(renderHomePage("ABC-1/demo"), /ABC-1\/demo/);
});

test("the home page carries the export button", () => {
  assert.match(renderHomePage("main"), /id="export-button"/);
});

test("the home page links every region", () => {
  const html = renderHomePage("main");
  for (const region of listRegions()) {
    assert.match(html, new RegExp(`/export\\?region=${region}`));
  }
});

test("the CSV carries a header and one line per comparable", () => {
  const rows = listComparables("north");
  const lines = toCsv(rows).trim().split("\n");
  assert.equal(lines[0], "address,surface,price");
  assert.equal(lines.length, rows.length + 1);
});

test("an unknown region has no comparables", () => {
  assert.deepEqual(listComparables("nowhere"), []);
});
