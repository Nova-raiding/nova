# Candidate New API management session: one-shot refresh

This is a controlled operation for the existing New API refresh cookie, not a
replacement for a New API user login or a proof of administrator permissions.
Do not run it merely because the API `/healthz` reports model readiness.

`scripts/new-api-session-refresh.ts` sends **one** `POST /api/user/auth/refresh`
with the exact HTTPS `Origin`. It requires the returned access token, expected
user ID, and a new `Secure; HttpOnly; Path=/api/user/auth` refresh cookie. It
then writes a mode-0600 temporary file, fsyncs it, renames it over the session
file, and fsyncs the directory. It prints only the state and user ID. The
mode-0600 `.lock` remains after any outcome so an ambiguous network response
cannot silently trigger another refresh.

Preconditions:

1. Freeze the release and identify the **actual** New API user who owns the
   current `MODEL_RELAY_LOG_REFRESH_COOKIE`. Confirm that account is permitted
   to create its own candidate API tokens. A model `sk-` key is not a panel
   management credential.
2. Stop any concurrent consumer of the same refresh cookie. Use a persistent,
   owner-only (0700) directory mounted at the **same path** in every relevant
   API replica. Set `MODEL_RELAY_LOG_SESSION_FILE` to a file inside it. The
   current 101 path, `/var/lib/merchant-assets/relay-session.json`, is in a
   0755 directory and is deliberately rejected until this is corrected.
3. Supply `MODEL_RELAY_LOG_BASE_URL`, `MODEL_RELAY_LOG_USER_ID`, and the existing
   refresh cookie from the protected secret store to the local process. Never
   place the cookie on the command line or in shell history. Ensure the runtime
   UID owns the directory. The tool prefers an existing safe session file over
   the environment cookie.
4. On the controlled host with Node 22, run the reviewed candidate script with
   `--execute --confirm-origin=https://<exact-relay-origin>`. Do not automate a
   retry or remove the lock after a timeout. Inspect the protected session file
   and the upstream session state before any manual recovery.
5. Use the persisted short-lived `userToken` only for authenticated management
   reads first. Confirm `/api/user/self` and `/api/token/` access without
   printing token values. Then create short-lived, finite-quota,
   model-restricted candidate keys; read each back with `/api/usage/token`.
   Preserve the existing production keys for rollback.

The remote refresh transaction and local filesystem rename are **not one
atomic transaction**. A host crash after upstream rotation but before the
response is durably saved can lose the session. The retained lock makes that
case fail closed; it does not make recovery automatic. If the current cookie's
validity, owner, protected persistent directory, or exclusive-use window
cannot be proven, do not refresh and keep the release blocked. The official
[New API session contract](https://github.com/QuantumNous/new-api/blob/main/docs/authentication.md)
specifies cookie rotation and its limited replay window; the
[token management API](https://github.com/QuantumNous/new-api-docs/blob/main/docs/api/fei-token-management.md)
requires a user credential rather than a model key.
