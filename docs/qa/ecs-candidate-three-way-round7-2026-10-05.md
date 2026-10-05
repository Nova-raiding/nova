# ECS candidate three-way transient review — round 7 (2026-10-05)

This read-only review closes the 63 rows that round 5 could not persist under the source-only policy. Exact host bytes were read transiently from `101:/opt/merchant-deploy`, compared with candidate `59eb1e8…` and trusted host base `85575f9c…`, then discarded. Only hashes, classifications and merge statuses are retained.

- Rows reviewed: **63**
- Raw remote bytes persisted: **no**
- Approved: **0**

| Classification / merge result | Count |
|---|---:|
| `double_change / error_5` | 2 |
| `double_change / error_7` | 3 |
| `double_change / error_2` | 10 |
| `double_change / clean` | 24 |
| `double_change / conflict` | 9 |
| `double_change / error_4` | 6 |
| `double_change / error_3` | 6 |
| `double_change / error_11` | 1 |
| `double_change / error_8` | 1 |
| `double_change / error_13` | 1 |

The transient pass improves byte-level coverage, but it does not approve any path: clean merges need semantic owner attestation; conflicts and merge-tool errors need manual review; protected paths still require host-context review. Per-file hashes and results are in the adjacent JSON.
