# Capability/capacity evidence audit — 2026-10-05 (round 10)

Round 10 completed a final deep, read-only inventory of candidate bundles, host evidence/deployment/candidate-render roots, runtime handoff paths, trust receipts, and isolated-runtime attestation files. No signer, installer, deployment command, or file mutation was run.

## Candidate binding

The candidate remains Git `59eb1e8db78005a2f9be1b8a808507422ffc82b8` with source SHA `sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`. A full candidate source-tar listing contains capture/attester programs and example schemas, but no captured capability document, signed manual-operations document, capacity cloud-gate report, runtime handoff, or release bundle. No candidate artifact path or content binds `59eb1e8` or `release-59eb1e8`.

## Host evidence inventory

The host search found many historical evidence directories and trust receipts. Every inspected `isolated-runtime-attestation.json` was either `status=review_only` for another release (`ecs-eeab1ae5`, `ecs-edcb3e68`, `ecs-73675593`, `ecs-dc63e0b9`, `ecs-e3c9a7aa`, `ecs-6d229025`, `release-ef35c3d2-20261001`) or invalid/empty (`ecs-3ec2a9f2`). None contained the current candidate Git SHA, image set, or release ID, and none declared final production evidence.

The host trust directory has attester digests, key ID/public key, and nonce-consumer receipts. These are trust controls, not capability/capacity evidence. `/var/lib/merchant-release-security/runtime-evidence` remains absent. The known demo runtime still points its API mounts at root-owned three-byte placeholder files from `release-85575f9c`; the application user cannot read them.

Historical capacity files are release-specific `no_load` declarations or old reports with `cloud_gate=false`, expired windows, and nonmatching release identities. The deep content search produced no current-candidate match.

## Current public state

`/api/releasez` remains `ecs-3dc76c93b536` with Git `3dc76c93b53652190f03454b305c86931e5f72ae`, not the candidate. `/api/healthz` and Ops `/healthz` return HTTP 200 but both report `productionEvidence.capability.state=blocked` and `productionEvidence.capacity.state=blocked` because the configured evidence paths cannot be read.

## Decision

`CAPABILITY_EVIDENCE=BLOCKED_NO_CURRENT_CANDIDATE_ATTESTATION`.

`CAPACITY_EVIDENCE=BLOCKED_NO_CURRENT_CANDIDATE_ATTESTATION`.

No historical review-only attestation, trust receipt, source example, placeholder, or old `no_load` report was reused. The release remains NO-GO until a single candidate-bound runtime produces real observations, protected signing, runtime handoff, and exact release/image/manifest binding.
