# AlignFirst Protocols

When the user names AlignFirst with one of these protocols, or uses a protocol alias, run `{{CMD}} guide <protocol>` and follow it. Do not reload a guide already in context. Each guide includes the ticket directory and work file rules; use `--protocol-only` when those rules are already in context.

Protocols and aliases:

- `spec` (`alspec`)
- `plan` (`alplan`)
- `aad` (`AAD`, `al`)
- `merge` (`almerge`)
- `review` (`alreview`)
- `description` (`aldescription`)

Catch-up workflows and aliases:

- Catch up (`alcatchup`) — run `{{CMD}} ticket --catchup`.
- Catch up, then `aad` (`alcatchupaad`) or `spec` (`alcatchupspec`) — run `{{CMD}} ticket --catchup`, then follow the selected protocol.
