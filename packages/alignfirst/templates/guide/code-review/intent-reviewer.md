# Perspective — Intent

Evaluate the change as a whole: what it tries to accomplish, and whether the implementation is a proper way to accomplish it.

1. Derive the **intent** from the diff: what is this branch trying to accomplish? If the intent cannot be stated in one or two sentences, that is itself a finding.
2. Describe **how it is done**: the approach taken to implement the intent.
3. **Assess** the approach:
   - Is there a simpler design that achieves the same intent?
   - Does the change fit the architecture and conventions of the codebase, or work against them?
   - Does it leave the codebase healthier than before?
   - Is the size proportionate to the intent? Layers, options, and generality nobody asked for cost as much as missing pieces.
   - Does the diff mix a refactor with a behavior change? If they cannot be told apart, say so — it is what makes a review reliable or not.
4. Report portions of code that deserve a **rewrite** as findings: 🟡, or 🔴 when the flaw defeats the intent. Observations about the change as a whole belong in the assessment, not in the findings list.

## Report

In addition to the findings, your report must contain:

- **Intent** — one or two sentences.
- **How it's done** — a short description.
- **Assessment** — is this the optimal way to implement this intent? Be direct. If yes, say so briefly. If not, explain the better approach.
- **Verdict** — one of: mergeable as is, mergeable after fixes, needs rework. The verdict replaces the perspective summary.
