# ECS candidate `review_required` three-way audit, round 3 (2026-10-05)

This is a read-only audit. It does not approve a merge, overwrite a host file,
or authorize staging/deployment.

The audit re-read all 240 `review_required` paths from `101:/opt/merchant-deploy`
using descriptor-relative, no-follow-symlink traversal and SHA-256 hashing. The
readback had 240 regular files, with 240/240 hashes exactly matching the
candidate `sync-plan.tsv`; no path was absent, non-regular, unreadable, or
mismatched. The readback was performed at 2026-10-04T22:24:32Z (UTC).

Inputs and durable readback:

- Candidate Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- Candidate parent: `088f112b273408bad2ac40e82eb4b0b3c4cf71d6`
- Sync plan SHA-256: `5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`
- Candidate archive SHA-256: `88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
- JSONL readback artifact (ignored deployment-candidate directory):
  `remote-review-hash-readback-round3.jsonl`
- JSONL readback SHA-256: `8d16430d7b42b299cd92db8f418dde30bc473f21dec8ae3b32d59a52c5022dad`

The byte/ancestry review remains unresolved. The candidate bundle persists only
174 remote byte streams; 66 bytes are unavailable. Of the 174 persisted
streams, 172 have a matching historical candidate-ancestry blob identity and 2
(`apps/api/src/server.ts`, `demo/merchant-studio/src/api.ts`) do not. The host
has no `.git` checkout, so no remote commit, parent, or merge-base is attested.
A historical blob match is not a three-way merge approval. No per-file merge
approval is recorded in this round, and aggregate approval remains `false`.

The 240/240 hash readback proves only that the host contents still match the
plan at read time. It does not prove provenance, semantic compatibility, or that
any candidate file can be safely applied. The required next evidence is a
trusted remote commit/parent (or persisted remote bytes plus an explicitly
reviewed base) and a human-reviewed per-file three-way decision.
