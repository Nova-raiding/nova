# Candidate-new confirmation round 9 — 2026-10-05

Bundle: `ecs-20261004T214923Z`
Candidate Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
Fresh remote observation: `2026-10-04T23:15:33.721Z`

Read-only recheck against `101:/opt/merchant-deploy` confirms the same candidate and remote state:

- 401/401 candidate-new records are `remote_state=absent`; unique paths 401/401.
- `approved=true`; source archive, sync-plan, and candidate identity remain bound; archive/local digest mismatches: 0.
- Normalized report digest: `e6c0b2d1933cdc48efc827a0c6123f6e1c1d520b903b3ec7f00131c4fb46dea4`, equal to canonical report.
- Candidate bundle still has no signed runtime evidence, immutable image-set manifest, release identity, or `/releasez` capture; matching source filenames are not runtime evidence.
- Triage remains NO_GO for independent three-way/protected/runtime gates.

No production files, containers, or release metadata were written.
