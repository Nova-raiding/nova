# Candidate-new confirmation round 6 — 2026-10-05

Bundle: `ecs-20261004T214923Z`
Candidate Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
Archive SHA: `sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
Observed at: `2026-10-04T22:39:36.309Z`

Fresh read-only confirmation was run against host alias `101` and root `/opt/merchant-deploy` using `infra/scripts/confirm-ecs-candidate-new-files.mjs`.

- `count=401`, `files=401`, `approved=true`
- `remote_read_only=true`; all 401 paths returned `remote_state=absent`
- every record has `archive_member=true`; `archive_sha256` equals `local_sha256` and the bound sync-plan digest
- unique paths: 401/401; digest mismatches: 0

The prior canonical report is preserved as `candidate-new-file-confirmation.previous-round6.json`. Triage was rerun after installing the fresh report; candidate-new validation remains approved. Triage remains `NO_GO` solely for unrelated three-way/protected/runtime gates.
