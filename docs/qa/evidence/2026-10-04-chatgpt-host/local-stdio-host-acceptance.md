# Local stdio host acceptance (read-only)

Date: 2026-10-04

Command:

```bash
node apps/plugin/scripts/verify-installed-bridge.mjs \
  --source apps/plugin \
  --installed ~/.codex/plugins/cache/merchant-local/merchant-marketing/0.1.0+codex.20261003154414 \
  --expected-package-profile qa-broker
```

Result: `ok: true`.

- Installed version: `0.1.0+codex.20261003154414`
- Package profile: `qa-broker` (expected and installed match)
- Tool surface: 120 source / 120 installed; missing 0, forbidden 0, duplicates 0, cache drift false
- Unconfigured `workspace.health`: fail-closed `MCP_CONFIGURATION_REQUIRED`
- Conversation refresh: unverified; an already-running ChatGPT conversation may retain its original tool snapshot
- Connect helper: source verified; signed app bundle and production readiness are false

The correct host acceptance path is: complete Store Nova merchant authorization in the browser, fully quit and relaunch ChatGPT/Codex, start a new conversation, then call read-only `onboarding.status`. Market search is not part of local stdio acceptance and no ChatGPT OAuth is required.

Targeted tests passed: `host-evidence-contract.test.ts`, `verify-installed-bridge.test.ts`, `install-local-plugin.test.ts` — 3 files, 22 tests.
