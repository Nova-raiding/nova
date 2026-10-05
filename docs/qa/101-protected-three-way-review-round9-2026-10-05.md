# 101 protected three-way review — round 9 (2026-10-05)

Read-only candidate-bound comparison of all 23 protected paths against `101:/opt/merchant-deploy`, candidate `59eb1e8…`, and trusted host base `85575f9c…`. Raw protected bytes were transient only and were not persisted.

- Paths reviewed: **23/23**
- Regular non-symlink remote files: **23/23**
- Authenticated owner attestations: **0**
- Approved: **0/23**

| Classification / merge result | Count |
|---|---:|
| `double_change / error_5` | 1 |
| `double_change / clean` | 8 |
| `candidate_only / not_applicable` | 1 |
| `double_change / error_2` | 2 |
| `double_change / error_11` | 1 |
| `double_change / conflict` | 4 |
| `double_change / error_3` | 3 |
| `double_change / error_7` | 1 |
| `double_change / error_8` | 1 |
| `double_change / error_4` | 1 |

The 8 byte-clean results still require semantic owner decisions. Four conflicts and eleven merge-tool errors require manual inspection. The candidate remains blocked from staging/deployment. Per-file hashes and classifications are in the adjacent JSON.
