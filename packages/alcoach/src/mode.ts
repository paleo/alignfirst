export interface CallbackConfig {
  url: string;
  token?: string;
  sessionKey: string;
}

export interface ModeResolution {
  isBackground: boolean;
  callback?: CallbackConfig;
}

export interface ModeError {
  error: string;
}

export interface ModeInput {
  callbackUrl?: string;
  sessionKey?: string;
}

// Background iff a callback target is resolvable (OpenClaw configured it). A configured URL with no
// --session-key is a misconfiguration and fails loudly rather than silently degrading to foreground.
export function resolveMode(input: ModeInput, env: NodeJS.ProcessEnv): ModeResolution | ModeError {
  const url = input.callbackUrl ?? env.ALIGNFIRST_COACH_CALLBACK_URL;
  if (!url) return { isBackground: false };
  if (!input.sessionKey) {
    return {
      error:
        "Error: a callback URL is configured but --session-key is missing. " +
        "Pass --session-key (from the session_status tool) to target the callback.",
    };
  }
  return {
    isBackground: true,
    callback: { url, token: env.ALIGNFIRST_COACH_CALLBACK_TOKEN, sessionKey: input.sessionKey },
  };
}

export function isModeError(mode: ModeResolution | ModeError): mode is ModeError {
  return "error" in mode;
}
