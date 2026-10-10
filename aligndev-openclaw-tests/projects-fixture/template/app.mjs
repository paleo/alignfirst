import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import express from "express";
import { handleExport } from "./export-handler.mjs";
import { renderHomePage } from "./home-page.mjs";

const port = Number(process.env.PORT ?? readLocalEnvPort());
if (!Number.isInteger(port)) {
  console.error("No port: set the PORT env var, or run `pnpm workspace setup` to get a local.env");
  process.exit(1);
}

function readLocalEnvPort() {
  try {
    const content = readFileSync(new URL("./local.env", import.meta.url), "utf-8");
    return content.match(/^PORT=(.+)$/m)?.[1];
  } catch {
    return;
  }
}

const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
const app = express();
app.get("/", (_req, res) => res.type("html").send(renderHomePage(branch)));
app.get("/export", handleExport);
app.listen(port, () => console.log(`listening on ${port}`));
