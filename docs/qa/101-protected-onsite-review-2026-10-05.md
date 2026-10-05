# 101 protected-path host review (2026-10-05)

This is a read-only review of the 23 protected paths in candidate
`ecs-20261003T210500Z-936954d4`. The review was performed against the fixed
SSH alias `101` and `/opt/merchant-deploy`.

The host-side command used a Python reader over `ssh -o BatchMode=yes 101`.
For each path it opened regular files without following links and emitted only
the path, SHA-256, byte count, mode, UID and GID. File contents were not
returned or persisted. The resulting records are in the ignored candidate
artifact `artifacts/deployment-candidates/ecs-20261003T210500Z-936954d4/protected-onsite-structure-review.json`.

Results:

- 23/23 paths were present as regular files.
- 23/23 host SHA-256 values matched the exact `remote_sha256_bound_to_plan`
  values in `remote-structure-review.json` (zero mismatches).
- The report is bound to candidate Git SHA
  `936954d4c5f8f0ffa76e75cd8012ad99e42699c5`, its source archive digest and
  its sync-plan digest.
- `remote_read_only=true` and `raw_remote_bytes_persisted=false`.
- Host file metadata showed root-owned mode `0750`/`0644` on protected deploy
  scripts and compose layers where applicable; no metadata mutation occurred.

This evidence establishes host-side hash and file-metadata matching only.
It does not establish a semantic review of protected wiring or approve a
three-way merge, staging, or deployment. The earlier description of this
evidence as a completed structural review was too broad.


## Current-candidate recheck

A new read-only SSH check on 2026-10-05 verified the 23 protected paths for
`ecs-20261004T214923Z`, candidate Git SHA
`59eb1e8db78005a2f9be1b8a808507422ffc82b8`. The older report above is not
bound to this candidate and must not be carried forward as its approval.

The source archive is bound to
`sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`,
and the sync plan to
`sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`.

All 23 paths were regular files opened without following symbolic links; all
23 observed hashes matched the bound sync plan. Only hashes, byte counts,
file modes and owner IDs were returned. No remote file was modified and no
raw file bytes were returned or saved. The sanitized artifact is
`artifacts/deployment-candidates/ecs-20261004T214923Z/protected-onsite-hash-review.json`.

The artifact explicitly records `approved=false`,
`review_scope=hash_and_metadata_only`, and
`semantic_review_completed=false`. Matching hashes prove which files still
need protected host-context review; they do not show that the remote-only
wiring has been reviewed or preserved in a proposed merge. Protected semantic
review and the 240-file three-way merge remain incomplete.

The triage-consumed copy is
`artifacts/deployment-candidates/ecs-20261004T214923Z/protected-onsite-structure-review.json`.
It uses the current `ecs-protected-onsite-review/1` schema and retains the
same `approved=false`, `review_scope=hash_and_metadata_only`, and
`semantic_review_completed=false` fields. Running
`node infra/scripts/triage-ecs-sync-plan.mjs` against this candidate reports
`protected_onsite.approved=false` and keeps
`protected_onsite_review_not_approved` as a blocker.

## Round 4 read-only recheck (2026-10-04T22:28:10Z)

The owner re-ran the host check against the same candidate using `ssh -o
BatchMode=yes -o ConnectTimeout=10 101`. The remote reader opened every path
beneath `/opt/merchant-deploy` with directory and file `O_NOFOLLOW` flags and
returned only JSON metadata (`path`, byte count, SHA-256, mode, UID and GID).
It did not write to the host, return file contents, or persist raw remote
bytes.

- The exact sync-plan protected subset was 23 paths; 23/23 were regular files.
- 23/23 observed SHA-256 values matched the candidate-bound remote digests;
  there were zero mismatches.
- The check was bound to candidate Git SHA
  `59eb1e8db78005a2f9be1b8a808507422ffc82b8` and the candidate's existing
  source/archive and sync-plan identity fields.
- This remains `approved=false`, `review_scope=hash_and_metadata_only`, and
  `semantic_review_completed=false`; hash and metadata parity cannot approve
  protected wiring or a three-way merge.
