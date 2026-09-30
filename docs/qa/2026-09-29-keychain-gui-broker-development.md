# macOS Keychain GUI broker development evidence

Date: 2026-09-29

## Implemented

- Added `mcp/keychain-broker.mjs`, a detached Node broker started after the interactive macOS binding flow succeeds.
- Broker socket directory is owned by the current UID and forced to mode `0700`; the Unix socket is owned by the current UID and forced to mode `0600`.
- Client verifies directory type, symlink status, owner and mode, then verifies socket type, owner and mode before connecting.
- Protocol accepts exact schemas for `ping`, `read`, `read_optional`, and `write`; service and account formats are fixed. Unknown fields and operations are rejected.
- Broker and client emit only fixed error codes. They do not log requests, responses, credentials, or helper stderr.
- Runtime Keychain access uses the broker only and fails closed when it is absent. Direct helper access is explicit and limited to interactive login/enrollment bootstrap.
- Source and marketplace mirrors, packager file list, and installed-runtime verifier were updated.

## Tests

Command:

```text
npx vitest run apps/plugin/mcp/keychain-broker.test.ts apps/plugin/mcp/keychain-credential.test.ts apps/plugin/mcp/managed-token.test.ts apps/plugin/scripts/login-local-macos.test.ts apps/plugin/scripts/enroll-local-macos.test.ts --no-file-parallelism
```

Result: 5 files passed, 49 tests passed.

`node --check` passed for the broker, Keychain adapter, and login script. `git diff --check` passed.

## Current boundary

This is a local development recovery path, not release-ready evidence. The broker is detached from the graphical login process and has not yet been installed as a signed Aqua LaunchAgent. Peer isolation currently relies on macOS filesystem enforcement for the UID-owned `0700` directory and `0600` socket; there is no native `getpeereid` assertion. Crash/reboot lifecycle and a real ChatGPT Background-to-GUI Keychain call still require runtime verification.
