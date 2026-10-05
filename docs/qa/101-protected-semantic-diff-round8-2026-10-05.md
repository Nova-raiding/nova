# 101 protected semantic diff review (round 8, 2026-10-05)

Candidate Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
Candidate archive: `sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
Candidate sync plan: `sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`

Read-only deep scan and hash recheck at `101:/opt/merchant-deploy`.

- 23/23 protected paths were opened as regular files with `O_NOFOLLOW`.
- 23/23 observed SHA-256 values match the exact sync-plan remote digests.
- No trusted `.git` checkout, candidate identity, revision manifest, signed baseline/attestation, or owner signature was found at any depth searched.
- `.gstack/qa-reports/baseline.json` and `artifacts/audit-*/qa/baseline.json` are QA reports, not deployment identity attestations.
- All rows remain `REVIEW_REQUIRED`; semantic diff is `not_run`; aggregate approval remains `false`.

Only sanitized path, hash, size, mode, UID and GID metadata is retained. No raw remote bytes were persisted.
