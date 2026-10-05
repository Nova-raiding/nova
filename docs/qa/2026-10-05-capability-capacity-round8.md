# Capability/capacity evidence audit — 2026-10-05 (round 8)

Round 8 expanded the read-only search to all candidate-related JSON/text files under the local candidate package and to `/var/lib/merchant-release-security`, `/run/release-evidence`, and `/opt` on host `101`. No host or container mutation was performed.

## Candidate and public identity

The current candidate remains:

- Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- source SHA: `sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
- comparison manifest: `sha256:dcbb2f0a2527a7bab6791f0669abdd25d875380d324da16cd6190c480e809a44`
- sync plan: `sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`

A host-wide content search found no file containing `59eb1e8` or `release-59eb1e8` under the searched roots. The public `/api/releasez` still returns `ecs-3dc76c93b536`, Git `3dc76c93b53652190f03454b305c86931e5f72ae`, manifest `d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`, and image set `sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`. Both public health endpoints returned HTTP 200 but continue to report capability and capacity as blocked because their configured paths cannot be read.

## Runtime mounts and image provenance

A sanitized Docker inspection on `101` found the running API containers in project `merchant-demo-85575f9c` mount these historical placeholder sources:

- `/var/lib/merchant-release-security/demo-first-install/release-85575f9c/capability.placeholder.json` → `/run/release-evidence/platform-capability.json`
- `/var/lib/merchant-release-security/demo-first-install/release-85575f9c/capacity.placeholder.json` → `/run/release-evidence/capacity-report.json`

The API labels identify source/revision `fa6beb91…` and release labels `release-fa6batch-spreadsheet`; the worker labels identify `fa6beb91…` with release `release-fa6batch-import`; merchant and Ops UI labels identify `dc63e0b9…`; payment identifies `0fa18b78…`; pilot gateway identifies `3567df1e…`. These are mixed provenance and none is the current candidate SHA. The host-wide search found no candidate-bound runtime handoff under `/var/lib/merchant-release-security/runtime-evidence` and no candidate evidence mount.

The host contains an installed/root-only capability attester and historical install receipts. Those receipts prove only control installation; they do not prove a capture or provide a candidate-bound signed artifact. Historical capacity files are other releases' expired or `no_load` declarations with `cloud_gate=false`; none matches the candidate identity and none was reused.

## Decision

`CAPABILITY_EVIDENCE=BLOCKED_NO_CURRENT_CANDIDATE_ARTIFACT`.

`CAPACITY_EVIDENCE=BLOCKED_NO_CURRENT_CANDIDATE_ARTIFACT`.

The expanded search found no readable, current-candidate-bound evidence. The runtime still mounts placeholders from an older demo release and has mixed image provenance. No stale file, fixture, placeholder, or attester output was installed or rebound. Production remains NO-GO pending a single reviewed candidate image/runtime set, real isolated-preproduction capacity observations, authorized manual capability canary observations, and the protected signer/handoff for that exact release.
