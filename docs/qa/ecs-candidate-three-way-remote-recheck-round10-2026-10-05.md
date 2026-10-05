# ECS candidate three-way remote recheck — round 10 (2026-10-05)

Read-only recheck against `101:/opt/merchant-deploy`; no host writes and no raw remote bytes persisted.

- Candidate: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- Trusted base / merge-base: `85575f9c257c5186116e16fc0bde58d25c25f8ed`
- Remote files re-read: **240 / 240**
- SHA matches: **240 / 240**
- SHA mismatches: **0**
- Regular non-symlink files: **240 / 240**
- `.git`: **absent**; `source-head.txt`: **absent**
- `release-metadata.json` SHA-256: `f17d693e877cacc3360d4035a9a82ede7145aec0148fcfbcbfd01fcf67ec25c0`
- Authenticated owner attestations: **0**
- Approved: **0/240**

The host remains byte-stable but lacks a trusted remote revision. Files with manifest/attestation names are compiled/source tests and are not signed, candidate-bound owner decisions. All rows remain `UNRESOLVED`; hashes alone do not authorize semantic merge or deployment.

Per-file SHA and lstat observations are in the adjacent JSON artifact.
