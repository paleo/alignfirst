import { readFileSync } from "node:fs";

import { CliError } from "./cli-error.js";
import { errorMessage } from "./errors.js";

export function readInstructions(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    throw new CliError(`Cannot read ${path}: ${errorMessage(error)}`);
  }
}
