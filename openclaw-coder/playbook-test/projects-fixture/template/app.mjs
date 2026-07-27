import { execSync } from "node:child_process";
import express from "express";
import { handleExport } from "./export-handler.mjs";
import { renderHomePage } from "./home-page.mjs";

const port = Number(process.env.PORT);
if (!Number.isInteger(port)) {
  console.error("PORT env required");
  process.exit(1);
}

const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
const app = express();
app.get("/", (_req, res) => res.type("html").send(renderHomePage(branch)));
app.get("/export", handleExport);
app.listen(port, () => console.log(`listening on ${port}`));
