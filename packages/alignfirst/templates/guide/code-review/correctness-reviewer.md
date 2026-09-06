# Perspective — Correctness

Logic bugs pass linters and compilation; this perspective covers exactly what the tooling cannot.

## Logic and Edge Cases

| Signal | Question | Severity |
| --- | --- | --- |
| New or modified condition | Are the bounds right? `<` vs `<=`, first and last element, equality case. | 🔴 |
| Loop over a collection | What happens when it is empty? Does the code after the loop assume it ran at least once? | 🔴 |
| Access to a field of a possibly absent object | Is the absent case handled, or merely tolerated by the typing? | 🔴 |
| Missing `else` or `default` branch | Is the uncovered case impossible, or just not considered? If impossible, is it proven (exhaustive type, invariant) or assumed? | 🔴 |
| Early return added | Does it skip code that had to run — cleanup, logging, release? | 🔴 |
| Comparison of values that can be zero, empty string, or false | Does the test distinguish "absent" from "present but falsy"? | 🔴 |
| Money or quantity computation | Floating point where exact decimals are required? Rounding applied once, at the right place? | 🔴 |
| Date, time, duration | Explicit or implicit timezone? Does the code assume UTC, server time, or user time — and is it the right one? Daylight-saving transitions handled? | 🔴 |
| Sort, deduplication, object comparison | Is the criterion total and stable? Are two "equal" elements equal in the sense the domain expects? | 🟡 |
| Collection modified while being iterated | Intentional, and defined behavior for this collection type? | 🔴 |
| Possible concurrent writes (handler, job, worker) | Can two simultaneous executions interfere? A non-atomic read-then-write is a race condition. | 🔴 |
| Non-idempotent operation on a retryable path | Does a replay produce a duplicate — double charge, double send? | 🔴 |

## Resilience

| Signal | Question | Severity |
| --- | --- | --- |
| New network call | Timeout defined? Without an explicit one, the default is often infinite. | 🔴 |
| Retry policy added | Bounded, with backoff? Is the retried operation idempotent? | 🔴 |
| Error-catching block added | Is the error handled, or swallowed? A swallowed error turns a loud failure into silent corruption. | 🔴 |
| Error caught and re-thrown | Is the original cause preserved? | 🟡 |
| Multi-step operation without a transaction | What remains if step 3 of 5 fails? Is an inconsistent intermediate state visible to another reader? | 🔴 |
| Batch processing | Does one failing item stop the whole batch? Is that the intended behavior? | 🟡 |
| Feature flag added | Is the default the old behavior? Is the disabled path tested? | 🟡 |

## Around the Diff

The most useful findings come from here, because nobody looks for them.

| Signal | Question | Severity |
| --- | --- | --- |
| Function modified | Who calls it? Do callers outside the diff assume the old behavior? | 🔴 |
| One occurrence of a pattern fixed | Does the same pattern exist elsewhere, unfixed? Report once, with the count. | 🟡 |
| Code the diff touches contains a bug unrelated to the diff | Report it as 🟣, without requiring a fix in this PR. | 🟣 |
| Constant, enumeration, or type union extended | Was every place that exhausts it updated? | 🔴 |
| Documented behavior modified | Do the documentation, comments, or repo instruction files now state something false? | 🟡 |

## Agent-Written Code

Plausible, well-formed code that is wrong about its assumptions. These checks add to the above.

| Signal | Question | Severity |
| --- | --- | --- |
| Call to a library method or option | Does it exist in the **installed version**? Check the manifest, not memory. APIs removed between major versions are the most frequent case. | 🔴 |
| Clean, complete implementation of the nominal case | Are the failure paths handled? This is the systematic deficit of generated code. | 🔴 |
