import { readFileSync } from "node:fs";

export function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  if (pkg.version === undefined) throw new Error("aligndev: package.json is missing 'version'");
  return pkg.version;
}
