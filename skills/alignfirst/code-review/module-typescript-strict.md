# Ecosystem Module — Strict TypeScript

For diffs in TypeScript with `strict` enabled. Apply the section matching your perspective, on top of your perspective file.

<!-- Maintainers: the JavaScript-runtime rows also live in module-javascript.md; keep them in sync. -->

## What the Tooling Covers (all perspectives)

With `strict` active, skip nullability findings on typed values — the compiler handles them. Check which of these are also active, and skip what they cover:

| Setting | If active, skip |
| --- | --- |
| `noUncheckedIndexedAccess` | Index access assumed defined |
| `exactOptionalPropertyTypes` | Absent property vs property set to `undefined` |
| ESLint `no-floating-promises` | Unawaited promises |
| ESLint `no-misused-promises` | Promise passed where a boolean or `void` is expected |
| Formatter (Prettier, Biome) | All formatting |

The limit that shapes this whole module: **the compiler verifies nothing at runtime.** Everything entering the program from outside is typed by declaration, not by verification. That is the main source of bugs that pass compilation.

## Correctness

| Signal | Question | Severity |
| --- | --- | --- |
| Truthiness test on a value that can be `0`, `""`, or `false` | `if (x)` is false for these. Was `if (x != null)` intended? | 🔴 |
| `??` replaced by `\|\|` or the reverse | `\|\|` triggers on every falsy value, `??` only on `null` and `undefined`. On a number or boolean, the difference is a bug. | 🔴 |
| `find`, `pop`, `shift`, `at`, `match` | They return `undefined` or `null`. Is that case handled? | 🔴 |
| Custom type predicate (`x is T`) added | Does the body really verify what the signature claims? A false predicate is a lie the compiler propagates everywhere. | 🔴 |
| `switch` on a union, without `default` or exhaustiveness check | A future member will pass silently. A `default` assigning to `never` forces a compile error. | 🟡 |
| Async function called without `await` or `.catch` | Floating promise: the result is ignored and a rejection surfaces far from its origin. Unless ESLint covers it. | 🔴 |
| `await` missing where the result is read | The code manipulates the promise instead of the value. Frequent symptom: an always-true condition. | 🔴 |
| `async` callback passed to a sync-expecting API (`forEach`, `filter`, `sort`, event handler) | The return is ignored, errors are lost, order is not guaranteed. | 🔴 |
| `try`/`catch` around an async call | Is the `await` **inside** the `try`? Outside it, the `catch` misses the rejection — unless the rejection is deliberately handled elsewhere. | 🔴 |
| `await` in a loop | Sequential on purpose, or parallelizable? | 🟡 |
| `Promise.all` on a collection of unbounded size | Unbounded parallelism: connection exhaustion, rate limiting downstream. | 🔴 |
| `Promise.all` where partial failure is acceptable — or `allSettled` whose statuses are not inspected | Is the failure mode chosen on purpose? `allSettled` keeps the successes; uninspected, it swallows the failures. | 🔴 |
| State updated after an async operation (frontend) | The component may be unmounted, or an older response may arrive after a newer one. Cancellation or guard? | 🔴 |
| `sort()` on numbers without a comparator | Lexicographic: `[10, 9, 1]` becomes `[1, 10, 9]`. | 🔴 |
| Arithmetic on money | Binary floats have no decimal exactness. Integers in the smallest unit, or a decimal library. | 🔴 |
| Integer from an external system | JSON deserialization silently loses precision beyond the safe range. | 🔴 |
| `Date` built from a string | Non-ISO parsing is implementation-dependent. Implicit timezone: client or server? | 🔴 |
| Copy via `{...x}` or `Object.assign` | Shallow: nested structures stay shared. Is sharing intended, or are they mutated downstream? | 🔴 |
| Mutation of a received parameter, array, or object | Does the caller expect its value to change? `readonly` prevents nothing at runtime. | 🔴 |
| `JSON.stringify` on an object holding `undefined`, `Map`, `Set`, `BigInt`, or a date | Silent loss, or exception. Can such values actually reach this payload? | 🟡 |
| Regex with the `g` flag reused | `lastIndex` persists between calls: alternating results. | 🔴 |
| Regex built from user input | Escaping, and catastrophic backtracking. | 🔴 |
| `catch (e)` | `e` is `unknown`: the thrown value is not necessarily an `Error`. Is `e.message` read without a check? | 🟡 |
| Error wrapped in a new one | Is `cause` used to keep the origin? | 🟡 |
| Discriminated error type extended | Do all consumption points handle the new member? | 🔴 |
| New import | Is the package in the manifest? Does the imported method exist in the **installed version**? | 🔴 |
| Import cycle introduced | Depending on evaluation order, a value can be `undefined` at load time. | 🔴 |

## Change Safety

The type of external data is a declaration, not a guarantee — the most important point of this module.

| Signal | Question | Severity |
| --- | --- | --- |
| HTTP response, queue message, file content, `localStorage` typed without validation | Is there runtime validation — schema, predicate, parser? Otherwise the type is a wish. | 🔴 |
| Environment variable read | Its real type is `string \| undefined`. Validated at startup, or read ad hoc with a `!`? | 🔴 |
| URL, route, or form parameter | Always a string. Is the conversion checked? `Number("abc")` yields `NaN` without an error. | 🔴 |
| Validation schema added or modified | Is the type inferred from the schema the source of truth, or does a parallel interface exist that can drift? | 🟡 |
| Type shared between client and server | Do both sides read the same definition, or two copies? | 🟡 |
| Import from a deep path of a package | Public API, or implementation detail? | 🟡 |

## Quality

The keywords `as`, `any`, and `!` are the signature of low-quality typing: each one turns off a verification.

| Signal | Question | Severity |
| --- | --- | --- |
| `as X` on a value of external origin | The assertion is a promise by the developer, not a verification. What does it rest on? | 🔴 |
| `as unknown as X`, or double assertion | Bypasses the guard against non-overlapping assertions. Almost always a wrong model. | 🔴 |
| `!` (non-null assertion) added | Does the guarantee really exist, or does it mask an unhandled case? On an environment variable or a search result, almost always the latter. | 🔴 |
| `any` introduced | Real dynamic boundary, or surrender? `unknown` forces narrowing; `any` disables everything — downstream callers included. | 🟡 |
| `@ts-ignore` or `@ts-expect-error` added | `@ts-expect-error` fails when the error disappears; `@ts-ignore` never does. Is the reason commented? | 🟡 |
| Type widened (`string` where a literal union existed, `object`, `{}`, `Function`) | Deliberate loss of precision, or drift? | 🟡 |
| Return type absent on an exported function | Inference silently propagates a type change to all callers. | 🟡 |
| Generic type parameter used once in the signature | It constrains nothing and infers nothing: a plain type is simpler. Layered conditional or mapped types deserve the same question. | 🟡 |
| Domain identifiers typed `string` | Two identifiers of different natures are interchangeable for the compiler. Branded type worth it? | 🟡 |
| Object literal assigned through an intermediate variable | Excess-property checking only applies to direct literals: a typo passes. `satisfies` keeps both checking and inference. | 🟡 |
| `as any` in a test to build a value | Does the test still validate the contract, or only the path? | 🟡 |
| Assertion on a promise without `await` in a test | The test passes no matter what. | 🔴 |
| Module mock in a test | Does the mock respect the real signature? An untyped mock accepts everything and detects no contract drift. | 🟡 |
