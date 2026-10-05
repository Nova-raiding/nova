# ECS 240 review-required history audit (2026-10-05)

This is a diagnostic audit only. It does not approve merge, staging, deployment, or overwrite of host files.

- Candidate Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- Candidate parent: `088f112b273408bad2ac40e82eb4b0b3c4cf71d6`
- Remote alias/root: `101` `/opt/merchant-deploy`
- Candidate sync plan: `artifacts/deployment-candidates/ecs-20261004T214923Z/sync-plan.tsv`
- Candidate tar: `artifacts/deployment-candidates/ecs-20261004T214923Z/candidate-source.tar`
- Remote checkout: `/opt/merchant-deploy` has no `.git` directory; no deployed source commit is available.
- `review_required` rows: **240**
- Exact remote bytes cached locally: **174**; unavailable: **66**
- Read-only SHA-256 readback from 101: all 240 paths (including the 66 paths whose bytes were not persisted) matched their plan SHA-256 at the read time; this proves current hash identity only, not merge ancestry.
- Candidate ancestry match: **172** cached remote files have a Git blob reachable in the candidate ancestry; this is only a blob match and does not establish a shared commit/merge-base.
- Remote bytes absent from candidate ancestry: `apps/api/src/server.ts`, `demo/merchant-studio/src/api.ts`.
- Merge base: **none attested**.
- Approval: **false**.

The full machine-readable audit is intentionally kept in the ignored deployment-candidate artifact directory as `three-way-history-audit-20261005.json`; its SHA-256 is `406e66c739e52bf39562c6a6afb4fd11aa0aba340c35738037b1f6e569d50d01`.

Because the host has no Git checkout and 66 required remote byte streams were not persisted, a complete three-way merge classification cannot be proved. The 172 historical blob matches must not be treated as approvals.
