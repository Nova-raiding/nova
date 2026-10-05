# Keychain trust and target binding audit (2026-10-05, round 5)

This is a metadata-only audit. No Keychain payload, access token, refresh
token, password, cookie, or secret was read or printed.

Observed at `2026-10-04T22:33:12Z` on the current macOS arm64 host:

- `security find-identity -v -p codesigning` reports `0 valid identities found`.
- The source and installed helper are byte-for-byte matched to the checked-in
  build record (`source_sha256=56b3d105...9db676`,
  `binary_sha256=eb4d3102...2c51b5`). `codesign --verify --strict` accepts the
  embedded seal, but `codesign --display --verbose=4` reports
  `Signature=adhoc` and `TeamIdentifier=not set` for both copies.
- The launchd metadata remains set to origin `https://yxsona.com`, target
  workspace `ws_57fd2361ed5b44c7891f3d37`, and token source `keychain`.
- The persisted binding file remains stale: it contains loopback origin
  `http://127.0.0.1:8787`, workspace `ws_be87dca95d714bc1bbdb6c21`, and no
  actor fingerprint. The diagnostic returned
  `loopback_to_production_origin`, `identity_fingerprint_missing`, and
  `workspace_changed`; it did not delete or reuse the stale identity.
- A metadata-only generic-password lookup found a Store Nova item for the
  target account hash `ea40339f...6a37` under service
  `com.storenova.merchant-mcp`. The item attributes were not read beyond
  service/account metadata, and no conclusion about its payload or usability
  is made.

## Gate result

`NO-GO`: without a legitimate Developer ID signing identity and Team ID, the
native helper's signed-ancestor contract cannot pass. The helper must continue
to fail closed. The presence of a metadata item is not evidence of a readable,
target-workspace credential.

## Required external handoff

On a release Mac with the legitimate Developer ID Application certificate and
notarytool profile, build and install the signed package, complete the normal
graphical login for `ws_57fd2361ed5b44c7891f3d37`, then restart ChatGPT and
verify a new plugin session. Preserve only signature metadata and numeric
Keychain OSStatus values in evidence.
