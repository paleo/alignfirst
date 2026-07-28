---
"@paleo/openclaw-test": patch
---

The judge's Anthropic client now retries up to 5 times, riding out transient container DNS failures instead of failing the cell.
