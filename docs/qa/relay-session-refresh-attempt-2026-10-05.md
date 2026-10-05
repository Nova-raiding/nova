# 101 relay session refresh attempt — 2026-10-05

Owner approved a single execution of the repository's existing
`scripts/new-api-session-refresh.ts` flow using only the API container's
configured relay credentials. No credentials or provider response bodies were
printed or copied into the repository.

- Target: `merchant-demo-85575f9c-api-1`, process UID 10001.
- Confirmed origin: `https://ai.wormholexyz.xyz`.
- Existing protected session path: `/var/lib/merchant-assets/relay-session.json`.
- Before execution: parent directory mode 0700, owned by process UID, not a
  symlink; session and session lock absent.
- Execution: original TypeScript source transpiled locally and streamed over
  SSH to `node --input-type=module`; no remote application source was changed.
- Single refresh result: `NEW_API_REFRESH_HTTP_401`.
- After execution: no session file; `.lock` retained, mode 0600, owned by
  process UID, not a symlink. No retry or lock deletion was performed.

This proves the configured refresh credential did not restore a session.
A new valid provider user session is required before authenticated log schema,
actual cost receipts, and current-release ledger matching can be verified.
No model generation, container environment change, or business-ledger mutation
was performed.

## Fresh browser session installed and independently verified

The user subsequently authorized configuration from their already logged-in
relay browser session. The domain-scoped authorization and fresh refresh cookie
were transferred only through process stdin and SSH, validated against the
configured user via `/api/user/self` and authenticated `/api/log/self`, then
atomically installed at the existing session path. The temporary local session
file and the transfer clipboard were cleared by the browser operator.

Independent verification found mode 0600, matching process ownership, a saved
refresh cookie, no active refresh lock, and one archived failed-401 lock. The
prior lock's PID was confirmed exited before its atomic archival; it was not
deleted. The log endpoint returned HTTP 200 with total 2039 records. The first
100 records all had numeric `id`, `user_id`, and `created_at`, and nonempty
string `request_id`; none named another user. No credentials or record values
were included in the schema output.

The current parser correctly falls back from the numeric row `id` to the
string `request_id`. None of the sampled rows has an explicit CNY cost field.
The JSON `other` field includes pricing ratios and, on some records, USD cost
and duration/pricing-mode evidence. These logs are reconciliation evidence;
raw `quota` must not be treated as CNY, and successful log authentication does
not by itself prove current-release generation or ledger settlement.
