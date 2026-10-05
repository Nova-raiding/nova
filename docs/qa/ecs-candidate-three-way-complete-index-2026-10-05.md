# Complete 240-file three-way index (2026-10-05)

This index combines round 5 acquisition metadata with round 7 transient readback. Every one of the 240 `review_required` paths has a candidate hash, trusted-base hash, remote hash, classification, and byte-level merge result.

- Candidate: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- Trusted base: `85575f9c257c5186116e16fc0bde58d25c25f8ed`
- Paths indexed: **240/240**
- Semantic approvals: **0/240**
- Raw remote bytes persisted for all paths: **no** (63 were transiently read under source policy)

| Classification / merge result | Count |
|---|---:|
| `candidate_only / not_applicable` | 39 |
| `double_change / clean` | 88 |
| `double_change / conflict` | 36 |
| `double_change / error_11` | 1 |
| `double_change / error_13` | 1 |
| `double_change / error_2` | 10 |
| `double_change / error_3` | 6 |
| `double_change / error_4` | 6 |
| `double_change / error_5` | 2 |
| `double_change / error_7` | 3 |
| `double_change / error_8` | 1 |
| `double_change / merge_tool_error` | 47 |

Byte-level results are not semantic deployment approval. Candidate-only and clean rows require authenticated owner attestations; conflicts and merge-tool errors require manual review.
