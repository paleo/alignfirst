import { readFileSync } from "node:fs";

const { ports } = JSON.parse(process.env.ALIGNFIRST_CONTEXT);
const domain = process.env.REMOTE_DEV_DOMAIN;
const host = process.env.REMOTE_DEV_HOST;
const publicUrl =
  domain !== undefined && domain !== ""
    ? `https://p${ports.frontend}.${domain}`
    : host !== undefined && host !== ""
      ? `http://${host}:${ports.frontend}`
      : `http://localhost:${ports.frontend}`;
let content = readFileSync(0, "utf8");
for (const [key, value] of Object.entries({ PORT: ports.frontend, PUBLIC_URL: publicUrl })) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  content = pattern.test(content)
    ? content.replace(pattern, () => `${key}=${value}`)
    : `${content.replace(/\n?$/, "\n")}${key}=${value}\n`;
}
process.stdout.write(content);
