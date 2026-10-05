# Local plugin Keychain binding review (2026-10-05)

This is a metadata-only review of the local Store Nova plugin binding. It does
not read, print, copy, or synthesize an access token, refresh token, password,
cookie, or Keychain payload.

Observed from the current shell (UTC `2026-10-04T22:13:10Z`):

- `launchctl managername` is `Background`; the graphical login domain is
  `gui/501`.
- Before repair, launchd metadata targeted `https://yxsona.com` and
  `ws_guirenniaoniao`. The saved binding metadata was schema `2`, loopback
  origin `http://127.0.0.1:8787`, workspace `ws_be87dca95d714bc1bbdb6c21`,
  and had no actor fingerprint. The binding diagnostic therefore returned
  `stale=true` with `loopback_to_production_origin`,
  `identity_fingerprint_missing`, and `workspace_changed`.
- The repository helper's source and binary hashes match
  `apps/plugin/mcp/keychain-credential-helper.build.json`; `codesign --verify`
  accepts the helper and the executable mode is owner-only. However,
  `codesign -dv --verbose=4` shows `Signature=adhoc` and
  `TeamIdentifier=not set` for both this helper and the installed version
  `0.1.0+codex.20261004155044`. Cryptographic code integrity alone is therefore
  insufficient for this helper's runtime trust requirement.
- A direct read attempt from this unsigned background Node process was refused
  by the helper. The command emitted no credential data. The helper requires
  its own nonempty team identifier before checking any ancestor, so the current
  ad-hoc build fails before calling Keychain even from a graphical session.
  This does not prove whether the target Keychain item exists.

The reversible metadata repair was applied with `launchctl setenv` for future
processes:

```text
MERCHANT_MCP_BASE_URL=https://yxsona.com
MERCHANT_WORKSPACE_ID=ws_57fd2361ed5b44c7891f3d37
MERCHANT_MCP_TOKEN_SOURCE=keychain
MERCHANT_STRICT_AUTH=true
MERCHANT_ALLOW_FIXTURE_FALLBACK=false
MERCHANT_MCP_WRITE_ENABLED=false
```

Any old environment token mirrors were removed with `launchctl unsetenv`; no
Keychain item or binding file was deleted. Existing ChatGPT processes retain
their inherited environment until a complete restart.

## Required graphical-session step

The target QA workspace is `ws_57fd2361ed5b44c7891f3d37` for the local
`demo@sn.com` acceptance. First supply the legitimate signed local package:
the native helper must have its authorized team identifier and be invoked
under verified ChatGPT or the same-team Store Nova Connect ancestor. Merely
rerunning the current ad-hoc build in Terminal cannot satisfy this gate.
Use that package's supported local login flow for this target:

```sh
node /path/to/verified-installed-plugin/scripts/login-local-macos.mjs \
  --base-url https://yxsona.com \
  --workspace ws_57fd2361ed5b44c7891f3d37
```

Complete the browser authorization for that workspace and wait for the page
to report that local credential persistence succeeded. Then fully quit and
reopen ChatGPT and verify a new plugin session. A browser authorization page
alone is not evidence of local persistence. If the helper still reports a
Keychain OSStatus, preserve only the numeric status and operation, without
logging any token or item data.
