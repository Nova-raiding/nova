# Immutable production local plugin release

Repository identity: `0.2.6`; plugin identity: `0.1.0+codex.20261005041942`.

The existing installed version had 122 tools while current source exposes 131. No versioned cache was overwritten. The repository release bump mechanism allocated 0.2.5 and then 0.2.6 in this preparation; 0.2.5 was never published. The second allocation was an operator error after incomplete asynchronous output, and 0.2.6 is retained as the final identity. Existing package-lock application dependency changes were preserved.

Production packaging uses the existing `package-local-plugin.mjs --profile production` workflow. It excludes the unauthenticated QA credential broker. Bundled installation uses `installBundledPlugin`; the QA-only CLI marketplace installer is not used as production evidence. The production profile does not imply code signing/notarization or completed ChatGPT host acceptance.

Runtime evidence and installation results will be appended after actual completion. No PostgreSQL/API fixture is started for this verification.

## Completed verification

- `release:metadata:validate` passed for 0.2.6, 383 MCP methods, 131 merchant tools and 13 Ops domains.
- Three version/manifest/surface test files passed: 27 tests (`plugin-new-version-tests.log`).
- Production archive built at `artifacts/local-plugin/merchant-marketing-0.1.0+codex.20261005041942-darwin-arm64.tar.gz`; bundled Node and macOS helpers were built by the existing packager.
- Real bundled installer succeeded in the isolated installation home; actual installed child stdio verifier passed production profile, complete runtime/provenance comparison, tools/list and unconfigured fail-closed probes (`plugin-production-isolated-install.json`, `plugin-production-isolated-stdio.json`).
- Real personal-home installation was attempted but rejected before any mutations: historical `.mcp.json` uses `sh ./mcp/bridge.sh`, while the installer recognizes only `./mcp/bridge.mjs`. Historical source/cache/config were left unchanged. This is an actual compatibility blocker, not a successful host upgrade.
- Existing versioned merchant-local caches were never overwritten. No QA broker, PostgreSQL fixture, API fixture, host restart or credential modification was used.
- Bundle status is {"schema_version":"1","release_status":"dirty_source_candidate","ready_to_install":false,"ci_test_certificate":false,"source_dirty":true,"chatgpt_app_bundled":false}. Production profile alone does not satisfy signing/notarization or clean-source release gates. Running ChatGPT host loading, live backend business flow and deployed protocol acceptance remain separate evidence.

## Final production-profile preparation: 0.2.7

The initial legacy entry blocker above was resolved by a new source release. Final repository identity is `0.2.7`; final plugin identity is `0.1.0+codex.20261005042504`. Single final bump completed with original process handle and zero exit; 041942 archive remains untouched.

Only the audited historical 20260907102000 entry (`command: sh`, exactly one `./mcp/bridge.sh` argument, regular non-symlink file with exact audited SHA-256) is recognized. Modified content is refused; source bridge path must also be a regular non-symlink. Runtime source/mirror are synchronized. Ten installer upgrade/rollback/config preservation regressions passed; final metadata/manifest/surface 27 tests passed.

Final production archive: `artifacts/local-plugin/merchant-marketing-0.1.0+codex.20261005042504-darwin-arm64.tar.gz`. Real isolated install and installed child stdio passed. Real personal entry then upgraded transactionally to `/Users/lixiaomei/.codex/plugins/cache/personal/merchant-marketing/local`. Old source is retained at `/Users/lixiaomei/plugins/.merchant-marketing-previous-4c99d6ab-c912-4292-a0ac-b5ec83d25bfd`; all 21 historical file records (path, digest, size, mode) match its archive. Old configuration is retained at `/Users/lixiaomei/.codex/.config-previous-4c99d6ab-c912-4292-a0ac-b5ec83d25bfd.bak` and its complete original bytes match. Old versioned merchant-local caches and credentials were not modified.

Real personal installed stdio verification passed: 131 tools, 68 runtime files with no missing/unexpected/digest mismatches, production profile and provenance match, and unconfigured workspace.health is blocked as MCP_CONFIGURATION_REQUIRED. See `plugin-final-production-summary.json`, `plugin-final-personal-install.json`, `plugin-final-personal-stdio.json`, and `plugin-final-isolated-stdio.json`. No API/PG fixture was started.

ChatGPT was not restarted and current host/tool snapshot refresh remains unverified. Installer marks login_required/restart_required; configured authenticated commercial runtime is not proven by this metadata/stdio verification. The package remains a dirty-source unsigned candidate (`ready_to_install: false`); production profile alone is not signing/notarization or a production connection-helper readiness claim.
