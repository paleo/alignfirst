---
"@alignfirst/openclaw-test": patch
---

Required `OPENCLAW_TEST_JUDGE_MODEL`: the judge no longer defaults to a model and fails before any request without it. The judge effort comes from the optional `OPENCLAW_TEST_JUDGE_EFFORT`, and the judge prices from `OPENCLAW_TEST_JUDGE_INPUT_USD_PER_MTOK` and `OPENCLAW_TEST_JUDGE_OUTPUT_USD_PER_MTOK`; without both prices, reports show the judge cost as unknown. `env up` sets the main agent model from `OPENCLAW_DEFAULT_TEST_MODEL` and fails early when it is unset. The runner also drops a provider whose model ID resolves empty.
