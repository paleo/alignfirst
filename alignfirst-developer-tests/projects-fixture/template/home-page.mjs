import { listRegions } from "./comparables.mjs";

export function renderHomePage(branch) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Comparables — ${branch}</title>
  </head>
  <body>
    <h1>Comparables</h1>
    <p>Branch: ${branch}</p>
    <ul>
${listRegions()
  .map((region) => `      <li><a href="/export?region=${region}">${region}</a></li>`)
  .join("\n")}
    </ul>
    <button id="export-button" style="font-weight: normal">Export</button>
  </body>
</html>
`;
}
