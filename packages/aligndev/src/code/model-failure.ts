import type { CodeConfig } from "../config.js";
import { renderAuthenticationFailure } from "./login.js";
import { modelPatternHint, ModelSignInRequiredError, PiStartupDialogError } from "./models.js";
import { nativeContext } from "./native-context.js";

const PI_STARTUP_DIALOG_ERROR =
  "A Pi extension opened a dialog at startup, which Pi's RPC mode cannot answer, so the model " +
  "pattern cannot be resolved from Pi's catalog. To fix it, pin a full `provider/model` selector " +
  "in the profile's `modelAliases`, or make the extension skip the dialog outside the terminal " +
  'UI (`ctx.mode !== "tui"`).';

export interface ModelFailure {
  message: string;
  authRequired: boolean;
}

// A catalog that requires sign-in takes the login handoff of a native authentication failure,
// without the catalog's output. Other failures name the selector, never the resolver's own message.
export function describeModelFailure(
  code: CodeConfig,
  cwd: string,
  selector: string | undefined,
  error: unknown,
): ModelFailure {
  if (error instanceof ModelSignInRequiredError) {
    return { message: renderAuthenticationFailure(code, cwd).instructions, authRequired: true };
  }
  return { message: modelResolutionError(code, selector, error), authRequired: false };
}

function modelResolutionError(
  code: CodeConfig,
  selector: string | undefined,
  error: unknown,
): string {
  if (error instanceof PiStartupDialogError)
    return `${PI_STARTUP_DIALOG_ERROR} ${nativeContext(code)}.`;
  const hint = modelPatternHint(code.harness, selector);
  return (
    `Could not resolve the ${code.harness} model; check --model, ` +
    "profile.models/modelAliases/modelFamilies and the agent installation. " +
    `${nativeContext(code)}.` +
    (hint !== undefined ? ` ${hint}` : "")
  );
}
