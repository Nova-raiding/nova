# Keychain trust and target-workspace audit (2026-10-05, round 6)

This is a metadata-only audit. No Keychain payload, access token, refresh
token, password, cookie, or secret was read or printed.

Observed at `2026-10-04T22:38:47Z` on the current macOS arm64 host:

- `/usr/bin/security find-identity -v -p codesigning` reports `0 valid
  identities found`.
- The checked-in helper and the installed cache helper have the same build
  manifest (`source_sha256=56b3d105...9db676`,
  `binary_sha256=eb4d3102...2c51b5`). `codesign --verify --strict` accepts
  both embedded seals. `codesign --display --verbose=4` reports
  `Signature=adhoc` and `TeamIdentifier=not set` for both copies.
- The helper's signed-ancestor check therefore remains fail-closed. No
  unsigned/ad-hoc replacement was installed and no trust check was weakened.
- The target binding is the production origin `https://yxsona.com` and
  workspace `ws_57fd2361ed5b44c7891f3d37`; its account identifier is the
  SHA-256 of `origin + newline + workspace` and was used only for metadata
  lookup.
- `security find-generic-password -s com.storenova.merchant-mcp` exposes a
  generic-password metadata item for the target account. The lookup did not
  request `-w`; no payload usability or target-workspace token was inferred.
- The persisted binding file remains stale (`http://127.0.0.1:8787`,
  workspace `ws_be87dca95d714bc1bbdb6c21`, missing actor fingerprint). The
  diagnostic reports `loopback_to_production_origin`,
  `identity_fingerprint_missing`, and `workspace_changed`. It was not
  rewritten because a new authenticated target-workspace credential is
  required; copying or relabeling the old token hash would be unsafe.

## Gate result

`NO-GO`: a legitimate Developer ID identity, Team ID, and signed/notarized
package are still absent. The metadata item is not evidence that the helper
can read a valid target-workspace credential. The local plugin must continue
to fail closed.

## Verification

The keychain contract tests pass: 5 files, 28 tests. They cover helper
manifest validation, ancestor/trust failures, QA broker isolation, workspace
binding validation, and managed-token handling.

## Required external handoff

On a release Mac with the legitimate Developer ID Application certificate and
notarytool profile, build and install the signed package, complete the normal
graphical login for `ws_57fd2361ed5b44c7891f3d37`, restart ChatGPT, and rerun
host acceptance. Preserve only signature metadata and numeric Keychain
OSStatus values in evidence.
