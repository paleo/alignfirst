import { listComparables } from "./comparables.mjs";

const COLUMNS = ["address", "surface", "price"];

export function handleExport(req, res) {
  const rows = listComparables(req.query.region);
  // Known defect: an empty region ends the response with no payload, so the
  // browser sees a 204 and the export button reports a failure.
  if (rows.length === 0) {
    res.status(204).end();
    return;
  }
  res.type("csv").send(toCsv(rows));
}

export function toCsv(rows) {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((column) => row[column]).join(","));
  }
  return `${lines.join("\n")}\n`;
}
