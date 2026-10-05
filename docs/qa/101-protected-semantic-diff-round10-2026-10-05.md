# 101 protected semantic diff review (round 10, 2026-10-05)

Candidate Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
Candidate archive: `sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
Candidate sync plan: `sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`

Read-only exact-marker check and fresh O_NOFOLLOW read of all 23 protected paths at `101:/opt/merchant-deploy`.

- No `.git`, candidate identity, release identity, revision manifest, baseline attestation, owner attestation, or signature sidecar exists.
- `release-metadata.json` remains 224 bytes, SHA `f17d…`, with only version/schema/tool-count keys.
- 23/23 protected files are regular, hashes match sync-plan, and metadata is valid.
- Semantic diff remains `not_run`; all decisions remain `REVIEW_REQUIRED`; aggregate approval remains `false`.

No remote files were modified and no raw remote bytes were persisted.
