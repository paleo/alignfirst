# Light Code Review

One reviewer, one pass, for a minor change. You are that reviewer. This guide replaces the perspective guides and the ecosystem modules.

## Scope

- Review `git diff <comparison_point> HEAD`. The review target is HEAD as committed.
- Fresh eyes: derive everything from the code and the diff. Do not read specs, plans, summaries, or any file in the ticket directory (under `.plans/`).
- Read-only: never modify the working tree, the index, or HEAD.

## Method

Assume nothing works until the code shows it does: your job is to find how this change goes wrong.

Read the diff once, with the checks below in mind. A check applies only when its signal is visible in the diff. A defect in the changed code is a finding even without a matching check.

To settle a doubt, read the code, including files outside the diff: callers, configuration, the installed version of a dependency. Never guess.

A signal is a place to look. A finding is a mismatch between what the code tries to do and what it does. A deliberate pattern producing the intended behavior is nothing to report.

## Findings

| Marker | Level | Meaning |
| --- | --- | --- |
| 🔴 | Important | Would break behavior, leak data, or block a rollback. Fix before merge. |
| 🟡 | Nit | Worth fixing, does not block. |
| 🟣 | Pre-existing | Real bug, present before this diff, in code the diff touches. |

A check's severity is a ceiling. Report a finding only when all of these hold:

1. **Evidence.** It rests on code you read, cited as `file:line`.
2. **Concrete trigger.** You can name the input, state, or call sequence that produces the problem.
3. **Beyond the tooling.** The formatter, linter, compiler, type-checker, or an existing test would miss it.
4. **The author would fix it** if made aware: one precise defect with a fixable remedy, at the level of rigor of the rest of the codebase.

Exception: a high-impact risk (data loss, security) that you could not fully verify may be reported with an explicit uncertainty note.

When in doubt, prefer silence: a wrong finding costs the author a read, a reply, and some trust in the review. Zero findings is a valid outcome.

Leave out personal preferences between equivalent idioms, generated files and lockfiles, test coverage as a metric, and the rephrasing of comments that are right. A pattern repeated N times is one finding with the count.

## Checks

### Intent

State what the change tries to accomplish, and how. Then assess it: is there a simpler design for the same intent? Does it fit the architecture and conventions of the codebase? Is its size proportionate to the intent?

### Correctness

| Signal | Question | Severity |
| --- | --- | --- |
| Condition, loop, or access to a possibly absent value, new or modified | Bounds, empty collection, absent value, "absent" against "present but falsy": is each case handled, or merely tolerated by the typing? | 🔴 |
| Function modified | Do callers outside the diff assume the old behavior? | 🔴 |
| Code, branch or condition removed | What did it handle? Is that case now impossible, handled elsewhere, or silently dropped? | 🔴 |
| Constant, enumeration, or type union extended | Was every place that exhausts it updated? | 🔴 |
| Error-catching block added | Is the error handled, or swallowed? | 🔴 |
| Clean, complete implementation of the nominal case | Are the failure paths handled? | 🔴 |
| Early return added, or resource opened | Do cleanup and release run on all paths? | 🔴 |
| Call to a library method or option | Does it exist in the installed version? Check the manifest, not memory. | 🔴 |
| Documented behavior modified | Do the documentation, comments, or repo instruction files now state something false? | 🟡 |
| Code the diff touches contains a bug unrelated to the diff | Report it, without requiring a fix in this change. | 🟣 |

### Change Safety

| Signal | Question | Severity |
| --- | --- | --- |
| Public signature, API field, serialization format, or default value changed | Are all callers and consumers in the diff? Otherwise, is the change compatible with them, and with existing data and configurations? | 🔴 |
| Entry point, query, file path, outbound URL, or log that carries external input | Same authentication as its neighbors? Input parameterized, constrained, encoded? No secret or personal data written? | 🔴 |
| Package added to the manifest | Does it exist under exactly this name? Is it necessary? | 🔴 |
| Environment variable or configuration key added | Safe default, or refusal to start without it? Documented in the diff? | 🟡 |

### Quality

Flag explicit violations of the repo conventions collected in Phase 1, citing the rule. Check that the new code matches its neighbors in structure, error handling, and naming.

| Signal | Question | Severity |
| --- | --- | --- |
| Test added | Would it fail if the behavior it claims to verify broke? | 🔴 |
| Assertion modified, test deleted or skipped | Was the test fixed, or aligned with a bug? Which behavior stops being verified? | 🔴 |
| Behavior change without a test | Is the modified behavior verified anywhere? | 🟡 |
| Dead code, unused export, or duplicated logic introduced | Does a repo utility already do this? Verify it exists before proposing a factorization. | 🟡 |
| Guard for a case already ruled out, or fallback to an empty value | Does it hide the real contract, or mask an absence that should be handled? | 🟡 |
| Comment describing what the code does, or justifying the current task | It is noise once merged. | 🟡 |

## Result

Carry into the next phase:

- the **intent**, **how it is done**, your **assessment**, and a **verdict**: mergeable as is, mergeable after fixes, or needs rework. A 🔴 finding forbids "mergeable as is".
- the findings. Each states its defect first, in present tense and plain words; evidence, trigger, and remedy follow. Compare HEAD to the comparison point, never commit to commit.
