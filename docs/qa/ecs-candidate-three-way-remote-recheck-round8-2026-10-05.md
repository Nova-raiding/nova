# ECS candidate three-way remote recheck — round 8 (2026-10-05)

Read-only recheck against `101:/opt/merchant-deploy`; no host files were modified and raw bytes were not persisted.

- Candidate: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- Trusted base / merge-base: `85575f9c257c5186116e16fc0bde58d25c25f8ed`
- Remote files re-read: **240 / 240**
- SHA matches: **240 / 240**
- SHA mismatches: **0**
- Regular non-symlink files: **240 / 240**
- `.git` directory: **absent**; `source-head.txt`: **absent**
- `release-metadata.json` SHA-256: `f17d693e877cacc3360d4035a9a82ede7145aec0148fcfbcbfd01fcf67ec25c0`
- Authenticated owner attestations: **0**
- Approved: **0/240**

## Findings

All 240 remote paths remain byte-stable relative to the prior bound hashes. The host still has no trusted Git revision or source head. Files whose names mention manifest/attestation are source/test files and do not provide a signed owner attestation bound to this candidate. All rows remain `UNRESOLVED`; hash stability does not authorize semantic merge or deployment.

Per-file hash and lstat observations are in the adjacent JSON artifact.
