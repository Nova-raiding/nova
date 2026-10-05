# 101 runtime evidence audit — 2026-10-05

Read-only observation at 2026-10-04 22:11–22:17 UTC. No evidence was installed and no container or file permissions were changed.

- Public `/releasez` reports `ecs-3dc76c93b536`, Git `3dc76c93b53652190f03454b305c86931e5f72ae`, manifest `d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`, image set `sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`, and `ready=true`. This HTTP projection does not prove container identity alignment.
- The serving API is in Compose project `merchant-demo-85575f9c`. Its labels instead report release `release-fa6batch-spreadsheet` and image revision `fa6beb91fdb81f4ebb2b676be3fa97baa7fb0ed5`.
- Both API evidence mounts refer to `/var/lib/merchant-release-security/demo-first-install/release-85575f9c/{capability,capacity}.placeholder.json`. Both are root:root 0600, 3 bytes (`{}` plus newline), SHA-256 `ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356`.
- API process UID/GID is 10001:10001. Direct `cat` and `sha256sum` of each mounted file return permission denied. `/api/healthz` reports both productionEvidence sections blocked with `CAPABILITY_EVIDENCE_PATH cannot be read` and `CAPACITY_REPORT_PATH cannot be read`.
- Host `/run/release-evidence/platform-capability.json` is an empty directory; it is not the current API bind source. `/var/lib/merchant-release-security/runtime-evidence` does not exist.
- The protected Node binary exists and returns v22.23.2. Installed capability attester SHA-256 and its trusted digest agree: `06f0314b7566ef58488ae4a60a6ddbfc87d5fce85047cbc5aa4f3bd57740d099`. The root-only signing key and public trust anchor exist; no private key bytes were read.
- Inventory of the protected evidence tree found no current-release manual capability candidate. Capacity files observed for releases `release-3dc0a88e-owner`, `release-20260923-ff4030f3`, `release-c1d28ed6-20260930`, `release-f72ebb49-20260930`, and `release-cffdaf10-20260930` are expired unsigned no-load declarations, not evidence for the current release.

The active connector profile is `manual_operations` for all six platforms. Follow `ecs-manual-operations-attester.md`: collect a real authenticated target-workspace `publish.manual.list` response and a rejected foreign-workspace request against the correctly bound release, sign with the installed manual attester, validate, and create a new root:10001 0440 runtime copy using the handoff helper. Official platform OAuth transcripts are not required for this manual profile.

Before capture, reconcile the serving image/release identity and obtain authorized target and isolation workspace credentials. Capacity needs the release owner's selected profile: a truthful no-load declaration makes no performance commitment; a load profile requires isolated preproduction target, workload token and reviewed identity. Existing declarations and `{}` files cannot be relabelled or installed as completed evidence.

Local verification: `node --test infra/protected/install-ecs-runtime-evidence.test.mjs tests/ecs-evidence-readable-by-api.test.mjs` — 8/8 passed. This verifies the handoff boundary, not production evidence completion.
