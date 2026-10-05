# Keychain helper signature and workspace binding audit (2026-10-05)

This audit is metadata-only. It does not read, print, copy, or synthesize a
Keychain secret or access token.

Observed at `2026-10-04T22:27:45Z` on the current macOS arm64 host:

- `security find-identity -v -p codesigning` reports **0 valid identities**.
- The source helper and installed helper are byte-for-byte consistent with the
  checked-in build record:
  - source SHA-256: `56b3d10561412279dfd7e7c2cace72d05d30024e11a6060672f2f0a9649db676`;
  - binary SHA-256: `eb4d3102b7f07f804fd1f609569a73f4eafaf16033d530470cab2f36b12b5`.
- `codesign --verify --strict` accepts the helper's embedded ad-hoc seal, but
  `codesign --display --verbose=4` reports `Signature=adhoc` and
  `TeamIdentifier=not set`. The same result is present in the installed
  `0.1.0+codex.20261004155044` helper. This cannot satisfy the production
  ancestor/team trust contract in `keychain-credential-helper.swift`.
- The launchd metadata is now bound to origin `https://yxsona.com`, workspace
  `ws_57fd2361ed5b44c7891f3d37`, and the `Background` manager. This confirms
  metadata repair only; it does not establish credential availability.
- A metadata-only `security find-generic-password` query for the Store Nova
  service returned nonzero with no output. No Keychain payload was exposed.
- No installed or cached artifact contains a `signed_notarized` production
  `bundle-status.json`; available local artifacts are unsigned candidates or
  release-ineligible QA broker packages.

## Gate result

`NO-GO`: no legal Developer ID identity, signed/notarized package, or trusted
Team ID is available on this host. The helper must continue to fail closed.
Do not replace the helper with an ad-hoc signature, weaken ancestor checks, or
seed a token through the QA broker for production acceptance.

## Required external handoff

On a release Mac with the legitimate Developer ID Application certificate and
notarytool profile, build via
`apps/plugin/scripts/build-signed-macos-package.mjs`. Install that package,
complete the supported graphical login for the target workspace, then restart
ChatGPT and re-run the host acceptance. Preserve only signature metadata and
numeric Keychain OSStatus values in evidence.
