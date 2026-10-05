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
