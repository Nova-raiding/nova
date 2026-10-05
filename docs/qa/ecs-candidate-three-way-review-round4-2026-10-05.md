# Candidate 240-file three-way review — round 4 (2026-10-05)

Read-only review against `101:/opt/merchant-deploy`. No host file was modified and no raw remote bytes were persisted.

- Candidate: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- Candidate parent: `088f112b273408bad2ac40e82eb4b0b3c4cf71d6`
- Sync plan: `sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`
- Exact remote files read: **240/240**

For every one of the 240 `review_required` paths:

- the exact host bytes were read and hashed;
- candidate bytes equal the candidate parent bytes;
- host bytes differ from both candidate and candidate parent;
- the three-way classification is `remote_only_change`.

This means the candidate has no recorded edit for these paths and would replace remote-only wiring. A trusted remote commit/parent or an explicit owner-reviewed preservation/merge decision is still required. The report is therefore `approved=false` and deployment remains blocked.

| Classification | Count |
|---|---:|
| `remote_only_change` | 240 |

Per-file hashes and byte counts are in [the JSON evidence](./ecs-candidate-three-way-review-round4-2026-10-05.json).

## Host archive probe

Two historical host source archives were checked read-only. Neither contains Git metadata, and neither is an exact current remote snapshot:

| Archive | SHA-256 | Current remote files matched |
|---|---|---:|
| `/opt/merchant-candidates/merge-20260915-1329/source.tar.gz` | `bd9e1e4ecc05d426378faf8303f6017a821f49a6326431acbb50452b537a523b` | 163/240 |
| `/opt/merchant-deploy/rollback/20260914162935/source-before.tar.gz` | `41135ccc75cbf275650e454b063d50ecf19fae2ded5354e52c9778d59e2ad6cb` | 123/240 |

These archives cannot serve as a trusted remote commit/parent or merge base.

A broader search of `/opt` and `/var/lib/merchant-release-security` found no Git bundle, checkout metadata, packed refs, or commit metadata. The only `source-head.txt` files belong to unrelated older candidate directories and do not match this candidate or the live release.
