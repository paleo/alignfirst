import { execFileSync } from "node:child_process";
import { CliError } from "./context.js";

export function git(dir: string, ...args: string[]): void {
  try {
    execFileSync("git", ["-C", dir, ...args], { stdio: "inherit" });
  } catch {
    throw gitFailure(args);
  }
}

// Git's own stderr is already on screen: callers let the child write to it.
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

export function gitSucceeds(dir: string, ...args: string[]): boolean {
  try {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
