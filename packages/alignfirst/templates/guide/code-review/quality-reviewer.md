# Perspective — Code Quality

A code review, above all, guarantees that the codebase stays healthy. This perspective is also the one that produces the most noise for the least value: apply it sparingly.

## Repository Conventions

The orchestrator gives you the repo's coding conventions (instruction files, coding-style skills). Flag only explicit violations, citing the rule. Convention adherence is the strongest quality signal available: it is written down, so it is not a matter of taste.

Also check consistency by example: does the new code match its neighbors in structure, error handling, and naming? Correct but mismatched code is a finding.

## Design and Size

| Signal | Question | Severity |
| --- | --- | --- |
| Function clearly larger than its neighbors | Can it be split without forcing? Deep nesting usually marks the split points. | 🟡 |
| Abstraction introduced with a single implementation | Does it solve a present problem, or an anticipated one? | 🟡 |
| Boolean parameter added to an existing function | Does the function now do two things? | 🟡 |
| New file | Is it in the right place per the repo's conventions? | 🟡 |

## DRY and YAGNI

| Signal | Question | Severity |
| --- | --- | --- |
| New code resembling existing code | Does a repo utility already do this? Verify it exists before proposing a factorization — proposing to extract what already exists is a classic false positive. | 🟡 |
| Same logic duplicated inside the diff | Extractable into one function? | 🟡 |
| Dead code, unused import, unreachable branch introduced | — | 🟡 |
| Export added | Is it imported from anywhere? | 🟡 |

## Suspicious Values

| Signal | Question | Severity |
| --- | --- | --- |
| Fallback to empty string or zero (`?? ""`, `or 0`, …) | Is the empty value really meant, or does it mask an absence that should be handled or raised? | 🟡 |
| Empty object or empty collection as a default or placeholder | Same question: does it hide an unhandled case? | 🟡 |
| Unexplained numeric or textual constant | Is its origin guessable? | 🟡 |

## Comments

| Signal | Question | Severity |
| --- | --- | --- |
| Comment describing *what* the code does | Should it describe *why* instead — or be removed? Ask for no comment on clear code. | 🟡 |
| Comment justifying the current task ("added for X", "now handles Y") | It is noise once merged. | 🟡 |

## Tests

| Signal | Question | Severity |
| --- | --- | --- |
| Behavior change without a test | Is the modified behavior verified anywhere? | 🟡 |
| Test added | Would it fail if the behavior it claims to verify broke? A test derived from the implementation proves the code does what the code does. | 🔴 |
| Vague assertion (truthiness, non-null, "does not throw") | Does it check the expected value, or only that something happened? | 🟡 |
| Test covering only the nominal path | The three most forgotten cases: empty collection, external-call failure, absent value. | 🟡 |
| Mock added | Does it reproduce the real contract of the dependency, or an idealized version that can never fail? | 🟡 |
| Test depending on the clock, network, execution order, or shared state | Source of flakiness. | 🟡 |
| Assertion modified to make a test pass | Was the test fixed, or aligned with a bug? Strong signal: find out why it failed. | 🔴 |
