import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildCodingAgentSettings } from "./coding-agent-settings.ts";

const [destination, ...extra] = process.argv.slice(2);
if (destination === undefined || destination.trim() === "" || extra.length !== 0) {
  throw new Error("Usage: write-coding-agent-settings.ts <destination>");
}
const settings = buildCodingAgentSettings(process.env);
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify(settings, null, 2)}\n`);
