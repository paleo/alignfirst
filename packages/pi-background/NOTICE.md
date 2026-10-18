# Provenance

`src/process-tree.ts` and its real-process conformance fixtures adapt the package-local cleanup leaf introduced by `packages/pi-subagent` at repository commit `97d1cd2`. This deliberate duplication keeps both extensions independently installable. Generic cleanup fixes must update both copies and their tests.

The original subagent package adapted Pi's MIT subagent example. The full Mario Zechner copyright and permission notice is retained in LICENSE. This package's background registry, output ring, native completion guard, and public tool contract are maintained here.

Design references reviewed for this work:

- `aliou/pi-processes`, commit `434fa0a860b1fa4fe9fccdc986964d865ef98e47` (cached source archive identifies `434fa0a`).
- `signalridge/pi-extensions`, commit `3ebe4317de18de0a724d88ea7a59e3360d04539b`, `@signalridge/pi-background@1.4.0` (cached source-match record verifies package files against that commit).

No code was copied from either ecosystem reference. Their schedulers, wake acknowledgements, persistence, and UI/adoption APIs are not included.
