---
"@paleo/openclaw-test": patch
---

Run the LLM judge at `temperature: 0` for deterministic verdicts. The judge classifies a message against a rubric; at the previous default temperature (1) it occasionally returned false negatives on otherwise-correct messages. Pair with structural assertions for fixed-template outputs — reserve the judge for free-form content claims.
