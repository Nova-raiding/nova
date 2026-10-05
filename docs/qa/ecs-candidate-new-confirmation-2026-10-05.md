# Candidate-new confirmation audit — 2026-10-05

Candidate bundle: `artifacts/deployment-candidates/ecs-20261004T214923Z`

The previous `candidate-new-file-confirmation.json` report was stale: its records omitted `archive_sha256`, which the current triage contract requires for every candidate-new path. The read-only confirmer was rerun against the exact candidate bundle and host alias `101` (`/opt/merchant-deploy`), then the report was replaced from the newly generated output.

Evidence from the rerun:

- `candidate_git_sha`: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- `candidate_archive_sha256`: `sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
- `candidate_sync_plan_sha256`: `sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`
- `remote_read_only`: `true`; `remote_state=absent` for all 401 paths
- `archive_sha256` is present and equals the sync-plan/local digest for all 401 records
- `node infra/scripts/triage-ecs-sync-plan.mjs artifacts/deployment-candidates/ecs-20261004T214923Z` reports candidate-new `approved=true`, `count=401`

Validation: `npx vitest run tests/ecs-sync-plan-triage.test.ts --reporter=dot` — 1 file, 4 tests passed.

This report confirms only candidate-new archive binding and read-only absence on host `101`; it does not approve protected onsite review, three-way merge review, or runtime evidence.
