# Ecosystem Module — Python

For diffs in Python. Apply the section matching your perspective, on top of your perspective file.

## What the Tooling Covers (all perspectives)

Check what runs in the repo before starting, and skip what is covered:

| Tool | Covers |
| --- | --- |
| Ruff / Flake8 | Mutable default argument, bare `except:`, `== None`, unused import or variable |
| Ruff (`ASYNC`, `S` rules) | Blocking call in async context, common security patterns (`shell=True`, `assert` in production) |
| mypy / pyright | Inconsistent signatures, unhandled `Optional` — **depending on the configured strictness**; without strict mode, most typing is unchecked |
| Black / Ruff format | All formatting |

If a tool is absent, its items belong to the review.

## Correctness

| Signal | Question | Severity |
| --- | --- | --- |
| Parameter default that is a list, dict, set, or function call | Evaluated once, at definition: the object is shared across calls. Unless the linter covers it. | 🔴 |
| Class attribute initialized with a mutable value | Shared by all instances. Intended? | 🔴 |
| Function defined in a loop, or comprehension capturing the loop variable | Late binding: the function reads the value at call time, not definition time. | 🔴 |
| List or dict assigned to another variable, then modified | Reference copy, not value. Also watch shallow copies of nested structures. | 🔴 |
| Truthiness test on a value that can be `0`, `""`, `[]`, `{}` | `if x:` is false for these. Was `if x is not None:` intended? | 🔴 |
| `is` comparing values (beyond `None`, `True`, `False`) | Identity, not equality. Works by accident on small ints and interned strings. | 🔴 |
| Collection modified while iterated | Undefined behavior. Iterate over a copy or build a new collection. | 🔴 |
| Custom objects in a `dict` or `set` | Are `__hash__` and `__eq__` consistent? A mutable object as key is a trap. | 🟡 |
| `datetime` built without timezone | Naive vs aware comparison raises. `datetime.now()` without a timezone in domain code is almost always a bug. | 🔴 |
| `except:` or `except Exception:` added | Catches what it should not. Which precise exception is meant? | 🔴 |
| `except ...: pass`, or `except ...: return None` | Can the caller distinguish "absent" from "failed"? | 🔴 |
| `try` block covering several operations | Does it catch exceptions from lines other than the one targeted? Narrow it. | 🟡 |
| Exception caught and re-raised | `raise New(...) from e` keeps the cause; without `from e` it is lost. | 🟡 |
| `logger.error` in an `except` | `logger.exception` captures the traceback; `logger.error` does not. | 🟡 |
| `assert` validating an input | Assertions vanish under `-O`. Not a validation mechanism. | 🔴 |
| `finally` containing `return` or `break` | It silently discards any in-flight exception. Is discarding intended? | 🔴 |
| `open`, connection, cursor, lock, session acquired without `with` | Released on all paths, including exception and early return? | 🔴 |
| Custom context manager added | Does `__exit__` release on exception? Does it return a truthy value, swallowing the exception? | 🔴 |
| Coroutine called without `await` | It never runs, silently. Search for this systematically: the most frequent async bug. | 🔴 |
| Blocking call in an `async` function (`requests`, `time.sleep`, sync DB call) | Blocks the whole event loop, not just the task. | 🔴 |
| `asyncio.create_task` without keeping the reference | The task can be collected before completion. Keep the reference, attach error handling. | 🔴 |
| `asyncio.gather` with `return_exceptions=True` | Are the returned exceptions inspected, or treated as results? Without the flag: one exception cancels the others — intended? | 🔴 |
| Mutable state shared between tasks or threads | Protected? Non-atomic read-then-write. | 🔴 |
| `ThreadPoolExecutor` or `multiprocessing` introduced | Are the passed objects serializable? Are worker exceptions retrieved? | 🟡 |
| `Optional` return added | Do all callers handle the absent case? | 🔴 |

## Change Safety

| Signal | Question | Severity |
| --- | --- | --- |
| Relation accessed in a loop (ORM) | Lazy loading fires per iteration: N+1. Eager loading possible? | 🔴 |
| Query built with `.format()`, f-string, or concatenation | Parameterize. Allowlist for dynamic identifiers. | 🔴 |
| `filter` without `limit` on a growing table | Bounded volume? | 🔴 |
| Session or transaction with a wide scope | Does it contain a network call? Does it close on error paths? | 🔴 |
| Auto-generated migration | Reviewed? Auto-generation regularly produces unwanted column drops and re-creations. Cross-check with the safety perspective's migration items. | 🔴 |
| `bulk_*` or mass insertion | Signals, validation, and application-level defaults are bypassed. Intended? | 🟡 |
| External data (JSON, environment, HTTP response) annotated with a precise type | The annotation is a declaration. Is there runtime validation at the boundary? | 🔴 |
| `pickle`, `marshal`, `shelve`, `yaml.load` on untrusted data | Arbitrary code execution. `yaml.safe_load` for YAML. | 🔴 |
| `eval`, `exec`, `compile` with non-constant input | — | 🔴 |
| `subprocess` with `shell=True`, or command built by concatenation | Pass an argument list. | 🔴 |
| `os.path.join` with a user-supplied segment | Does the resolved path stay under the base directory? | 🔴 |
| `random` used for a token, password, or session id | `secrets` for anything cryptographic. | 🔴 |
| `verify=False`, permissive TLS context | — | 🔴 |

## Quality

| Signal | Question | Severity |
| --- | --- | --- |
| `Any` introduced in a public signature | Real dynamic boundary, or surrender? | 🟡 |
| `# type: ignore` added | Targeted at a precise error code, with a comment? | 🟡 |
| `cast()` used | It rests on a guarantee the checker cannot see. Does that guarantee exist? | 🟡 |
| `pytest.raises` without `match=` | Verifies that *some* exception of the type is raised, not that it comes from the right place. | 🟡 |
| Fixture with `module` or `session` scope holding mutable state | State leaks between tests; order-dependent results. | 🟡 |
| `mock.patch` on an import path | Patched where the target is *used*, not where it is defined? Classic failure: the patch does not take, the test passes while testing nothing. | 🔴 |
| Bare `Mock()` configured | Accepts any attribute and any call. `autospec=True` or `spec=` constrains to the real contract. | 🟡 |
| Test depending on `datetime.now`, the filesystem, or the network | Flakiness. | 🟡 |
