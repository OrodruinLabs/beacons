# The engine's own patches

beacons' changes to the vendored teamclaude engine (`src/engine/`, `test/engine/`) since it was vendored in `064824e`. The edits and upstream ports it came with are listed in [its README](../src/engine/README.md).

- `0f064d1`: every upstream fetch is held to an egress allowlist (`api.anthropic.com`, `platform.claude.com`, loopback), and the login callback listens on loopback only. The path-preserving passthrough the commit names lives outside the engine, in `src/passthrough.ts`.
- `67cfbb0`: the `account_uuid` patcher skips plain string bytes natively (65 ms to 8 ms on a 1.2 MB body).
- `cc5747a`: the large-body patcher test no longer asserts a timing.
- `8645a92`: the request-body scanners (`account-uuid-rewrite.js`, `model.js`) jump to each string's closing quote and read only the keys they route on.
- `9a4b9ce`: the vendored `dns-transient` test is kept; it loads no module the vendoring dropped.

**teamclaude [#532](https://github.com/KarpelesLab/teamclaude/pull/532) (v1.1.25), a message-thread continue stays on its conversation: not taken.** It repairs upstream's per-conversation pinning (#438, v1.1.21), which keyed a continue on its delta and sent it to an account without its thread. Neither routing mode here keys on the delta: by default every request follows the one current account, and with `distributeSessions` the engine pins by the `x-claude-code-session-id` that a create and its continues share. So that bug does not occur here, and the patch cannot apply without #438 and the Codex provider code.

A continue can still reach an account without its thread after a restart, a pin expiry, an account switch or a 429 failover. That account answers 404 `thread_not_found`, beacons relays it untouched, and Claude Code resends the conversation in full; upstream accepts the same limit. The other half of the thread fix, a continue forwarded past the tool-pair repair, is already in the engine. Upstream made the same fix in #544 (v1.1.25), so the engine README's "not fixed upstream" note is now stale.

Guarded in `test/front.test.ts` by `front: a thread continue reaches the account holding its thread, distributeSessions off and on`, `front: a thread continue reaches upstream with its leading tool_result` and `front: a failed-over continue relays 404 thread_not_found untouched`.
