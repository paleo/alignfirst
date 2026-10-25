---
name: sharp-testing
description: "Rules for writing valuable automated tests without accumulating redundant or implementation-coupled checks. Read before implementing features, fixing bugs, refactoring, or writing and changing tests."
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.1.0"
  repository: https://github.com/paleo/skills
---

# Sharp Testing

Add a permanent test only when it closes a meaningful gap in protection. A code change does not automatically need a new test.

## Justify the protection

**What plausible mistake would this catch that existing checks would miss, and why would it matter?** Name the incorrect behavior and its consequence. Merely observing that the code could change is insufficient.

Inspect relevant tests. Prefer extending an existing behavioral test when it can clearly cover the missing case. Adding no tests is valid when existing protection suffices.

New functions, branches, and files are not reasons to add tests. Use coverage to investigate gaps, never as a target.

## Test requirements

Derive expected results from intended behavior, domain rules, or compatibility obligations. The implementation shows what the code does; it does not establish what it should do.

Do not generate expectations with the code under test. Validate captured outputs against requirements before adopting them as fixtures or snapshots.

## Exercise the claimed behavior

Keep the production logic responsible for the claimed behavior real. Substitute dependencies outside it. A mock that implements the asserted behavior proves the mock. A mocked write proves a write was requested, not persistence.

A rejection test must exercise the intended guard rather than fail earlier for an unrelated reason. For bug fixes, demonstrate failure on the defective code for the intended reason and success after the fix. State when the defective baseline cannot be verified.

## Assert what matters

Name tests after the behavior they protect. Assert relevant outcomes: returned values, persisted state, emitted events, or responses. Leave incidental wording, object fields, helper calls, and internal ordering unconstrained.

Exact text, bytes, or ordering need assertions only when their representation is required. Apply the same standard to snapshots. Verify interactions when the interaction itself is the contract, such as sending a notification exactly once.

## Cover distinct risks

Choose representative cases, meaningful boundaries, and relevant failure paths. Add cases for distinct defects, not every available input variation. Use properties when a general invariant expresses the requirement better than many examples.

Additional test layers must exercise additional risks. Do not replay every business-rule case through unit, integration, and end-to-end tests.

Consolidate repetitive cases without losing distinct boundaries. Keep setup readable rather than hiding it behind helper chains.

## Allow internal redesign

Test through interfaces that express meaningful behavior. Behavior-preserving refactors should leave assertions intact.

Avoid exports, flags, and wrappers whose sole purpose is exposing internals to tests. Improve the design when warranted; do not complicate production code to support an unnecessary test.

## Choose economical protection

Choose the cheapest boundary that convincingly exercises the risk:

- Calculations, algorithms, state transitions: focused unit tests.
- Wiring, persistence, lifecycle: integration tests with real collaboration.
- Critical complete workflows: end-to-end tests.

A broader test must justify its extra cost through additional protection.

Keep fixtures small, state isolated, and time and randomness controlled. Prefer completion signals over sleeps.

## Retain useful protection

Writing a test and retaining it are separate decisions. Temporary development tests earn a permanent place through useful ongoing protection.

Remove tests of obsolete requirements. Remove redundant tests only when their distinct failure modes remain protected. A passing broader test, overlapping coverage, or a history without failures does not establish redundancy.

Investigate a failing test before weakening its assertions or deleting it.
