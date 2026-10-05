# Keychain trust and package-signing audit (2026-10-05, round 8)

Metadata/trust checks only. No Keychain payload, token, password, cookie, or
secret was read or printed; the binding file was not modified.

Observed at `2026-10-04T22:58:50Z` on the current macOS arm64 host:

- `security find-identity -v -p codesigning`: `0 valid identities found`.
- Both checked-in and cached native helpers have the expected manifest and
  identical CDHash. `codesign --verify --strict` passes their embedded seal,
  but `codesign --display --verbose=4` reports `Signature=adhoc` and
  `TeamIdentifier=not set`.
- The only local DMGs are candidate/ChatGPT-bundled-final artifacts. Each
  fails `codesign --verify --strict` (not signed) and is rejected by
  `spctl --assess --type open`; neither is a signed/notarized production
  package.
- Target remains `https://yxsona.com`, workspace
  `ws_57fd2361ed5b44c7891f3d37`. Binding diagnostics remain stale with
  loopback origin `http://127.0.0.1:8787`, workspace
  `ws_be87dca95d714bc1bbdb6c21`, and missing actor fingerprint.
- Service-only Keychain metadata still lists a generic-password item whose
  account attribute is the target account hash. No payload read or usability
  claim was made.

## Gate result

`NO-GO`: no Developer ID/Team ID, signed/notarized package, or reusable
target-workspace binding is present. Continue fail-closed behavior and obtain
the required release-Mac signing identity and authenticated graphical login
before changing the binding.
