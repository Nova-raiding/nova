# ECS candidate review-required three-way semantic review, round 5 (2026-10-05)

Read-only classification bound to candidate `59eb1e8db78005a2f9be1b8a808507422ffc82b8` and trusted base/merge-base `85575f9c257c5186116e16fc0bde58d25c25f8ed`. No host file was modified and no staging/deployment approval is granted.

## Result

- Review-required rows: **240** (39 candidate-only, 201 double-change).
- Byte-level clean merges among persisted remote bytes: **64**; conflicts: **27**; merge-tool errors: **47**; remote bytes unavailable: **63**.
- Candidate-only rows have remote SHA equal to the trusted base SHA, but still require semantic owner sign-off.
- **Approved: 0/240.**

A clean byte-level merge does not prove policy, security, migration, runtime, or release correctness. Exact remote provenance and an explicit semantic decision are required for every path.

## Classification counts

- `candidate_only`: 39
- `double_change`: 201
- `merge_clean`: 64
- `merge_conflict`: 27
- `merge_merge_tool_error`: 47
- `merge_not_applicable`: 39
- `merge_remote_bytes_unavailable`: 63

The machine-readable per-file evidence is in the adjacent JSON.
