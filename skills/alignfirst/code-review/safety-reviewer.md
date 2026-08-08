# Perspective — Change Safety

What this change does to the systems around it: contracts, the database, security, data volume, dependencies.

## Contracts and Compatibility

| Signal | Question | Severity |
| --- | --- | --- |
| Public function signature modified | Are all callers in the diff? If not, is the change backward compatible? | 🔴 |
| Field removed or renamed in an API response, event, or queue message | Does an existing consumer still read it? Does a progressive deployment make both versions coexist? | 🔴 |
| Field added with a non-null constraint, or stricter validation | Do existing data satisfy the constraint? Do existing clients send the field? | 🔴 |
| Default value changed | Does the change apply retroactively to existing records or configurations? Is that intended? | 🔴 |
| Serialization format or cache key changed | Are entries written by the old version readable by the new one — and the reverse, during deployment? | 🔴 |
| Environment variable or configuration key added | Safe default, or refusal to start without it? Documented in the diff? | 🟡 |

## Database Changes

Migrations and ORM classes deserve particular attention: they are the part of a diff that can break production without breaking a single test.

| Signal | Question | Severity |
| --- | --- | --- |
| Schema migration | Is it backward compatible with the currently deployed application version? The rule: code deployed before the migration must keep working during and after it. | 🔴 |
| Destructive migration (column or table dropped, type changed) | Does it follow an expand / backfill / switch / contract split across deployments, or attempt everything at once? Is a rollback possible without loss? | 🔴 |
| Migration on a large table | Which lock is taken, for how long? Index created without a concurrent mode, massive `UPDATE` in one pass, type change rewriting the table. | 🔴 |
| Auto-generated migration | Was it reviewed? Auto-generation regularly produces unwanted drops and re-creations. | 🔴 |
| ORM model changed | Does it still match the schema after the migration? Are defaults and validations enforced at the same layer as before? | 🔴 |

## Security

| Signal | Question | Severity |
| --- | --- | --- |
| New entry point (route, handler, command, job) | Is it under the same authentication as its neighbors? An endpoint added without the neighboring middleware or decorator is the most frequent case. | 🔴 |
| Resource identified by a client-supplied parameter | Does the caller have the right to **this specific resource**, or only a generic right to the resource type? | 🔴 |
| Owner, organization, or tenant identifier read from the request | Does it come from a trusted source (session, verified token) or from the client-supplied body/parameters? | 🔴 |
| Query on a table with a tenancy column | Is the tenancy filter present? An unfiltered query in a partitioned system is a leak. | 🔴 |
| Query built by string concatenation or interpolation | Are values parameterized? Do dynamic identifiers (table, column, sort direction) go through an allowlist? | 🔴 |
| External data rendered in an output (HTML, template, document, structured log) | Encoded for the output context? | 🔴 |
| File path built from user input | Constrained to a base directory after resolution? | 🔴 |
| Outbound URL built from user input | Destination restricted? Otherwise the application relays into the internal network. | 🔴 |
| New log, error message, or trace | Does it contain a secret, personal data, a full request body, a token? | 🔴 |
| Constant that looks like a secret | Hardcoded key, token, password, connection string — including in tests and fixtures. | 🔴 |
| Deserialization of untrusted data | Does the format allow code execution? | 🔴 |
| Comparison of a secret, signature, or token | Constant-time comparison? | 🟡 |

## Data and Performance

| Signal | Question | Severity |
| --- | --- | --- |
| Query inside a loop, or in a function called in a loop | N+1. Can the loading be batched? | 🔴 |
| Query without limit or pagination | Is the volume bounded by construction, or only by today's data? | 🔴 |
| New filter or sort on a column | Does an index exist? Adding the query without the index is a finding. | 🟡 |
| Open transaction | Does it contain an external network call, a long wait, user interaction? Is its scope as narrow as possible? | 🔴 |
| Cache added or modified | What is the exact key — does it include every dimension the value depends on (tenancy included)? What is the invalidation? | 🔴 |
| Whole file, response, or result set loaded in memory | Is the size bounded? | 🟡 |
| Quadratic algorithm on a hot path | Realistic input size? Quadratic over ten elements is not a finding. | 🟡 |
| Resource opened (file, connection, lock, subscription) | Released on **all** paths, including exception and early return? | 🔴 |

## New Dependencies

| Signal | Question | Severity |
| --- | --- | --- |
| Package added to the manifest | Does it really exist, under exactly this name? Package-name confusion is an active attack vector. | 🔴 |
| Package added to the manifest | Is it maintained, and is its license compatible with the project? | 🟡 |
| Package added to the manifest | Is it necessary? Could the standard library or an already-installed dependency do the job? | 🟡 |
| Manifest changed without the lockfile, or the reverse | — | 🟡 |
| Dependency moved between runtime and dev dependencies | Is it used at runtime? | 🔴 |
