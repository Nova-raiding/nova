# ECS candidate three-way remote recheck — round 7 (2026-10-05)

Read-only recheck against `101:/opt/merchant-deploy`; raw host bytes were not persisted and no host files were modified.

- Candidate: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- Trusted base / merge-base: `85575f9c257c5186116e16fc0bde58d25c25f8ed`
- Remote paths re-read: **240 / 240**
- Remote digest matches: **240 / 240**
- Digest mismatches: **0**
- lstat regular files: **240**, symlinks: **0**
- Owner attestations: **0**
- Approved: **0/240**

The host still has no `.git` directory or `source-head.txt`. Every remote digest matches the previously bound round5 digest. No authenticated owner identity, attestation, timestamped decision, rationale, or checks record was found. All rows remain `UNRESOLVED`; byte stability does not prove semantic safety or authorize deployment.

Per-file hashes and lstat facts are in the adjacent JSON artifact.
