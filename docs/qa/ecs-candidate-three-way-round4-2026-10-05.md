# ECS candidate `review_required` three-way audit, round 4 (2026-10-05)

This is a read-only audit. It does not approve a merge, overwrite a host
file, or authorize staging/deployment.

## Inputs and trusted revision evidence

- Candidate Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- Candidate parent: `088f112b273408bad2ac40e82eb4b0b3c4cf71d6`
- Candidate sync-plan SHA-256: `5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`
- Host alias/root: `101:/opt/merchant-deploy`
- Host release identity read-only path:
  `/var/lib/merchant-release-security/demo-first-install/release-85575f9c/merchant-demo-release-85575f9c.identity`
- Host release Git SHA from that identity:
  `85575f9c257c5186116e16fc0bde58d25c25f8ed`
- Host release source SHA from that identity:
  `sha256:c152329446f0aede4d464a1aa00cf202a9fcb039d7547caa1751bf5e06da2eff`
- Local repository contains the host release commit and
  `git merge-base 59eb1e8db78005a2f9be1b8a808507422ffc82b8 85575f9c257c5186116e16fc0bde58d25c25f8ed`
  returns `85575f9c257c5186116e16fc0bde58d25c25f8ed`.

The release identity is a stronger revision signal than the previous
`merge_base: null` result. It still does not by itself prove that every byte
currently under `/opt/merchant-deploy` was produced from that release: the host
has no `.git` checkout, and its running image labels are mixed across release
identities. The identity therefore binds a candidate base revision for
classification, but not a deployment or merge approval.

## Per-file hash classification

The 240 `review_required` rows were reclassified without persisting new raw
remote bytes. For each row, the SHA-256 of the candidate file at `59eb1e8` and
at the host identity commit `85575f9c` was compared with the read-only remote
SHA-256 already bound in `sync-plan.tsv`:

| Classification | Count | Meaning |
|---|---:|---|
| Remote equals trusted base, candidate differs | 39 | Candidate-only change can be mechanically identified; semantic review is still required. |
| Remote differs from trusted base and candidate | 201 | Both sides changed (or the host identity is not the byte base); requires persisted remote bytes and per-file three-way review. |
| Base/candidate missing or other | 0 | No rows were silently dropped. |

The prior 174 persisted remote streams remain diagnostic only. The remaining
66 remote byte streams were not persisted under the source-acquisition policy;
hashes alone cannot establish a conflict-free semantic merge. The two known
paths whose persisted bytes were not present in candidate ancestry remain
`apps/api/src/server.ts` and `demo/merchant-studio/src/api.ts`.

## Decision

- `merge_base`: **attested for classification only** as
  `85575f9c257c5186116e16fc0bde58d25c25f8ed`.
- `approved`: **false**.
- Per-file three-way decisions: **0/240 approved**.
- Staging/deployment authorization: **none**.

To close this gate, the owner must bind the exact remote checkout to the
`85575f9c` release identity (or provide a newer signed identity), persist the
required remote bytes under the approved source policy, and record a reviewed
decision for all 240 paths. Hash equality and a merge-base alone are not
approval evidence.
