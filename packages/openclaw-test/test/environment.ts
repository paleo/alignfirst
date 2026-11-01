export function fixtureEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(FAKE_|OPENCLAW_|OPENAI_|ANTHROPIC_|OPENROUTER_|AZURE_OPENAI_|ZAI_|GEMINI_|GOOGLE_API_|AWS_BEDROCK_)/.test(
        key,
      ) ||
      /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)
    )
      delete env[key];
  }
  return env;
}
