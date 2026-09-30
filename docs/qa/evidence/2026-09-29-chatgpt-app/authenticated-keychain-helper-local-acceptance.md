# Authenticated macOS Keychain helper local acceptance

Date: 2026-09-29 CST

## Candidate behavior

- Production packages invoke the native Keychain helper directly.
- Before any `SecItem` read or write, the helper examines the live process ancestry with Security Framework APIs.
- It accepts only a strictly validated OpenAI ChatGPT ancestor (`com.openai.codex`, Team ID `2DC432GLL2`) or the Store Nova Connect helper signed by the same Team ID as the Keychain helper itself.
- QA packages retain the explicitly release-ineligible seeded broker. The production path does not fall back to the broker, environment tokens, or historical credentials.

## Local evidence

- `swiftc` compiled the native source successfully on macOS arm64.
- Invocation from the unsigned test shell failed closed: exit 1, zero stdout bytes, generic safe stderr.
- Four targeted files passed: 22 tests.
- Full repository TypeScript check passed.
- Scoped `git diff --check` passed.
- QA broker package construction succeeded and remained `qa_only`, `ready_to_install=false`, `source_dirty=true`.

No credential value was read, printed, persisted, or reused during this acceptance.

## Deployment prerequisites

Positive native IPC acceptance requires a clean production package in which bundled Node, the Keychain helper, Store Nova Connect, and the DMG pass Developer ID signing, hardened runtime checks, notarization, stapling, and Gatekeeper assessment. This machine currently has no suitable Developer ID identity, so the positive signed-ancestor and Keychain persistence path cannot be claimed as passed here.

Keep `LOCAL_PLUGIN_ONE_CLICK_ENABLED=false` until that signed package is installed and the complete browser → installation proof → PKCE → Keychain → fresh ChatGPT stdio flow passes on the release Mac. Opening the server flag is a deployment decision after those gates; it is not part of this local source validation.
