# Capability/capacity evidence audit — 2026-10-05 (round 7)

This round rechecked the current candidate, public health/release endpoints, and the 101 host read-only. No production file, container, volume, credential, or runtime setting was changed.

## Candidate and public identity

The newest local candidate remains `artifacts/deployment-candidates/ecs-20261004T214923Z`:

- Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- source SHA: `sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
- comparison manifest SHA: `sha256:dcbb2f0a2527a7bab6791f0669abdd25d875380d324da16cd6190c480e809a44`
- sync-plan SHA: `sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`

Both public endpoints returned HTTP 200, but `/api/healthz` and `ops.yxsona.com/healthz` still report:

```json
{"productionEvidence":{"capability":{"state":"blocked","configured":false,"reasons":["CAPABILITY_EVIDENCE_PATH cannot be read"]},"capacity":{"state":"blocked","configured":false,"reasons":["CAPACITY_REPORT_PATH cannot be read"]}}}
```

`/api/releasez` still advertises `ecs-3dc76c93b536`, Git `3dc76c93b53652190f03454b305c86931e5f72ae`, manifest `d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`, and image set `sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`. This is not the local candidate identity.

## 101 host evidence paths

The read-only host inventory reported:

```
/run/release-evidence type=directory uid=0 gid=0 mode=755
/run/release-evidence/platform-capability.json type=directory uid=0 gid=0 mode=755
/run/release-evidence/capacity-report.json MISSING
/var/lib/merchant-release-security/runtime-evidence MISSING
```

The `platform-capability.json` bind source is a directory, so it cannot be consumed as a JSON evidence file. No candidate-bound runtime handoff exists. The host does have a root-only capability attester and historical install receipts, but an installed signer is not capability evidence and does not prove a capture occurred.

Host capacity artifacts are historical `no_load` declarations for other releases (`release-3dc0a88e-owner`, `release-c1d28ed6-20260930`, `release-cffdaf10-20260930`, `release-f72ebb49-20260930`, among others). They declare `status=not_performed`, `cloud_gate=false`, and release IDs/SHA/config versions that do not match `59eb1e8…`; the September 30 declarations expired on October 2. They cannot be rebound or reused.

The host control-install receipt for the capability attester records an installation from source SHA `e9d4e222…`, but its installed artifact is an attester executable, not a signed evidence document. No current candidate manual-operations capture or signed capability artifact was found.

## Decision

`CAPABILITY_EVIDENCE=BLOCKED_CURRENT_CANDIDATE_RUNTIME_AND_CANARY_INPUTS`.

`CAPACITY_EVIDENCE=BLOCKED_CURRENT_CANDIDATE_ISOLATED_RUNTIME_INPUTS`. Existing files are directories, missing paths, stale no-load declarations, or historical source examples. No file is readable evidence for the current candidate, and no placeholder or stale artifact was installed.

The evidence gates therefore remain correctly fail-closed and production remains NO-GO. To proceed requires an identity-consistent candidate runtime/image set, an isolated-preproduction endpoint and workload credentials for capacity, authorized target/isolation workspace credentials for manual capability capture, and the protected signing/handoff sequence for that same release.
