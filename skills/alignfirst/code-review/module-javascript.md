# Ecosystem Module — JavaScript and Non-Strict TypeScript

For diffs in JavaScript, or in TypeScript without `strict`. Apply the section matching your perspective, on top of your perspective file.

Without `strict`, the type system verifies little: nullability passes, `any` spreads implicitly. The checks a strict compiler would do become review work — which makes this module larger than the strict one.

<!-- Maintainers: the JavaScript-runtime rows also live in module-typescript-strict.md; keep them in sync. -->

## What the Tooling Covers (all perspectives)

Check what runs in the repo before starting, and skip what is covered: ESLint rules (`eqeqeq`, `no-floating-promises`, …), `checkJs` with JSDoc, the formatter. If a tool is absent, its items belong to the review.

## Correctness

Nullability first — nothing checks it here:

| Signal | Question | Severity |
| --- | --- | --- |
| Property access on a value that can be `null` or `undefined` | Is the absent case handled on every path that reaches this access? | 🔴 |
| Function parameter assumed present | What happens when a caller omits it? | 🔴 |
| Index access on an array or record | The element can be `undefined`: is that handled? | 🔴 |
| Truthiness test on a value that can be `0`, `""`, or `false` | `if (x)` is false for these. Was `if (x != null)` intended? | 🔴 |
| `??` replaced by `\|\|` or the reverse | `\|\|` triggers on every falsy value, `??` only on `null` and `undefined`. On a number or boolean, the difference is a bug. | 🔴 |
| `find`, `pop`, `shift`, `at`, `match` | They return `undefined` or `null`. Is that case handled? | 🔴 |
| `==` used where types can differ | Coercion: `"" == 0` is true. Is `===` intended? Unless ESLint `eqeqeq` covers it. | 🔴 |
| Arithmetic or concatenation mixing strings and numbers | `"1" + 1` is `"11"`, `"2" * 1` is `2`. Is the conversion explicit? | 🔴 |
| `typeof x === "object"` | True for `null` too. | 🟡 |
| `NaN` possible (failed `parseInt`/`Number`, missing field) | `NaN` propagates silently and every comparison with it is false. Checked with `Number.isNaN`? | 🔴 |

Then the runtime pitfalls, shared with strict TypeScript:

| Signal | Question | Severity |
| --- | --- | --- |
| Async function called without `await` or `.catch` | Floating promise: the result is ignored and a rejection surfaces far from its origin. | 🔴 |
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
| Mutation of a received parameter, array, or object | Does the caller expect its value to change? | 🔴 |
| `JSON.stringify` on an object holding `undefined`, `Map`, `Set`, `BigInt`, or a date | Silent loss, or exception. Can such values actually reach this payload? | 🟡 |
| Regex with the `g` flag reused | `lastIndex` persists between calls: alternating results. | 🔴 |
| Regex built from user input | Escaping, and catastrophic backtracking. | 🔴 |
| `this` in a function extracted or passed by reference | Context lost. | 🟡 |
| Comparison of objects or arrays | Reference comparison. | 🟡 |
| Error wrapped in a new one | Is `cause` used to keep the origin? | 🟡 |
| New import | Is the package in the manifest? Does the imported method exist in the **installed version**? | 🔴 |
| Import cycle introduced | Depending on evaluation order, a value can be `undefined` at load time. | 🔴 |

## Change Safety

Every boundary is unchecked: no compiler backs the annotations.

| Signal | Question | Severity |
| --- | --- | --- |
| HTTP response, queue message, file content, `localStorage` consumed directly | Is there runtime validation — schema, predicate, parser — before the fields are used? | 🔴 |
| Environment variable read | It is `string \| undefined`. Validated at startup, or read ad hoc? | 🔴 |
| URL, route, or form parameter | Always a string. Is the conversion checked? `Number("abc")` yields `NaN` without an error. | 🔴 |
| JSDoc types or non-strict TS annotations on external data | They are documentation, not verification. Where is the runtime check? | 🔴 |
| Import from a deep path of a package | Public API, or implementation detail? | 🟡 |

## Quality

| Signal | Question | Severity |
| --- | --- | --- |
| In non-strict TS: `as X` or `!` on a value of external origin | The assertion is a promise by the developer, not a verification — and here nothing limits its blast radius. What does it rest on? | 🔴 |
| In non-strict TS: `any` added | Real dynamic boundary, or surrender? | 🟡 |
| In non-strict TS: code added that would fail under `strict` | Does it push the repo further away from ever enabling it? | 🟡 |
| `var` introduced | Function-scoped, hoisted. `let`/`const` unless there is a reason. | 🟡 |
| Side effect at module load (I/O, global mutation) | Import order becomes behavior. Intended? | 🟡 |
| Built-in prototype extended or mutated | — | 🟡 |
| Assertion on a promise without `await` in a test | The test passes no matter what. | 🔴 |
| Module mock in a test | Does the mock respect the real signature? | 🟡 |
