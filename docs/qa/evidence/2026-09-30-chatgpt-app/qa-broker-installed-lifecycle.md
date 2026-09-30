# QA Broker installed lifecycle acceptance

- Captured: 2026-09-30 06:27 CST
- Installed package: `0.1.0+codex.20260929213938`
- Profile: `qa-broker`; `qa_only=true`; `release_eligible=false`
- Scope: installed runtime, isolated Unix socket, local API, memory-only synthetic credential
- Real merchant credentials used or recorded: no

## Runtime observations

1. The installed-package verifier accepted the cache as the expected `qa-broker` profile. Runtime discovery succeeded with 116 tools.
2. The installed Broker started on a mode-0700 temporary directory and created its mode-0600 socket.
3. A new installed stdio Bridge initialized as version `0.1.0+codex.20260929213938`, listed 116 tools, read the Broker credential, and completed one read-only call against the isolated API.
4. ChatGPT (`com.openai.codex`) fully stopped and started. The Broker remained alive because its lifecycle is independent from ChatGPT.
5. A second fresh stdio Bridge again initialized, listed 116 tools, and completed the read-only call.
6. Explicit Broker `SIGTERM` removed the owned socket. A third fresh stdio Bridge failed closed with `MCP_CREDENTIAL_SOURCE_INVALID`; the isolated API received zero additional requests.

Verdict: **PASS for the installed QA runtime lifecycle.** The machine-readable evidence is in `qa-broker-installed-lifecycle.json` with mode 0600.

## Boundary

This run does not restore the default Store Nova Broker or claim that the real merchant account is logged in. The default socket was absent before the run and remains absent. The merchant web account logout currently revokes the remote session and MCP token but does not signal the local QA Broker; explicit local termination was used for the logout boundary. Production packages exclude this QA Broker.

The installed verifier reported `verification_scope=unpackaged_development_source` because this cache has no bundle provenance file. Profile, version, runtime inventory, MCP initialize, and tool discovery passed, but this specific cache should not be treated as a provenance-attested production artifact.
