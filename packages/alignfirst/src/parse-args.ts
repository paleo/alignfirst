import { CliError } from "./cli-error.js";
import { errorMessage } from "./errors.js";

export function parseCommandArgs<T>(usage: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    const detail = errorMessage(error).split("\n", 1)[0];
    throw new CliError(`${detail}\n\n${usage}`);
  }
}
