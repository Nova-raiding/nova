# ECS candidate three-way remote recheck — round 9 (2026-10-05)

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

Identity/attestation-looking paths on the host are compiled/source test artifacts. None is a signed, candidate-bound owner decision. All rows remain `UNRESOLVED`; unchanged hashes do not authorize semantic merge or deployment.

Per-file SHA and lstat observations are in the adjacent JSON artifact.
