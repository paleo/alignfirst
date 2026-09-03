import { execFileSync } from "node:child_process";

import { CliError } from "./cli-error.js";

export function git(dir: string, ...args: string[]): void {
  try {
    execFileSync("git", ["-C", dir, ...args], { stdio: "inherit" });
  } catch {
    throw gitFailure(args);
  }
}

function gitFailure(args: string[]): CliError {
  return new CliError(`git ${args[0]} failed. See the git output above.`);
}

export function gitOutput(dir: string, ...args: string[]): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }).trim();
  } catch {
    throw gitFailure(args);
  }
}

export function gitOutputOrUndefined(dir: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }
}

export function gitSucceeds(dir: string, ...args: string[]): boolean {
  try {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
