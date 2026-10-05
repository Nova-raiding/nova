# ECS candidate three-way merge execution — round 11 (2026-10-05)

The requested three-way merge was executed in an isolated temporary checkout
using:

- candidate tree: Git `59eb1e8db78005a2f9be1b8a808507422ffc82b8`;
- trusted base: merge-base `85575f9c257c5186116e16fc0bde58d25c25f8ed`;
- remote side: freshly acquired read-only bytes from `101:/opt/merchant-deploy`
  where the source policy permits acquisition.

Results for all 240 `review_required` paths:

- **100 clean** `git merge-file` results;
- **74 conflicts** with unresolved conflict markers, requiring semantic owner choices;
- **66 remote bytes unavailable** because protected/config paths are excluded from persisted source acquisition.

No result was copied into the main worktree and no remote file was modified.
Clean results are byte-level merge outcomes only; they do not constitute owner
approval. The 74 conflicts and 66 protected/config paths remain unresolved, so
the release gate correctly remains `NO_GO`.
