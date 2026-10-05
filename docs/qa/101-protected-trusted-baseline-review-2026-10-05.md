# 101 protected trusted-baseline review (2026-10-05)

Read-only review bound to candidate identity and 101 host metadata. No remote bytes were persisted.

## Binding

- Candidate Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- Candidate source archive: `sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
- Candidate sync plan: `sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`
- Remote: `101:/opt/merchant-deploy`
- Protected paths: **23**
- Remote release-metadata SHA-256: `f17d693e877cacc3360d4035a9a82ede7145aec0148fcfbcbfd01fcf67ec25c0`

## Trusted-baseline result

**Unavailable.** The host root has no `.git` checkout, no `.candidate-identity`, no revision-bearing release metadata, and no baseline/commit/identity manifest in the inspected deployment root. The candidate worktree history is not evidence of the host revision.

Consequently no semantic or three-way diff was run. The 23 rows retain `REVIEW_REQUIRED`; `approved=false` and `semantic_review_completed=false`. Hash equality/difference and file metadata remain structural evidence only.

## Read-only checks

- `remote_git_checkout`: absent
- `remote_candidate_identity`: absent
- `remote_revision_in_release_metadata`: absent (metadata has version/schema fields only)
- `remote_baseline_manifest`: absent through deployment-root depth 2
- Raw remote bytes: not persisted

## Approval gate

Approval requires a trusted remote revision or signed baseline manifest, then owner-approved per-path three-way decisions against the exact remote bytes. This report is not a deployment approval.
