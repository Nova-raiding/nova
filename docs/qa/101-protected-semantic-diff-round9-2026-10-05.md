# 101 protected semantic diff review (round 9, 2026-10-05)

Candidate Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
Candidate archive: `sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
Candidate sync plan: `sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`

A full read-only trusted-baseline/owner-attestation filename scan and a fresh 23-path O_NOFOLLOW hash read were performed against `101:/opt/merchant-deploy`.

- 23/23 protected files were present and regular.
- 23/23 SHA-256 values matched the candidate-bound sync-plan digests.
- No `.git`, candidate identity, revision manifest, signed owner attestation, `.sig`, `.asc`, or equivalent deployment provenance was found.
- Matching names under `dist/`, source, QA and historical audit material are not trusted host identity evidence.
- Semantic diff remains `not_run`; all rows remain `REVIEW_REQUIRED`; aggregate approval remains `false`.

Only sanitized path/hash/size/mode/UID/GID metadata is retained. No raw remote bytes were persisted.
