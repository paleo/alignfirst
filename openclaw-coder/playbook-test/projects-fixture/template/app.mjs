import { execSync } from "node:child_process";
import express from "express";

const port = Number(process.env.PORT);
if (!Number.isInteger(port)) {
  console.error("PORT env required");
  process.exit(1);
}
const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
const app = express();
app.get("/", (_req, res) => res.send(`Hello world from ${branch}\n`));
app.listen(port, () => console.log(`listening on ${port}`));
