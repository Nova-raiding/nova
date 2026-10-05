# Production runtime recheck — 2026-10-05 round 10

Read-only recheck at `2026-10-04 23:40:22 UTC`.

- `https://yxsona.com/api/healthz` and `https://ops.yxsona.com/healthz` returned HTTP 200, but both report `productionEvidence.capability.state=blocked` and `productionEvidence.capacity.state=blocked`.
- The reported reasons remain `CAPABILITY_EVIDENCE_PATH cannot be read` and `CAPACITY_REPORT_PATH cannot be read`.
- Host `101` still identifies the installed release as `release-85575f9c`, Git `85575f9c257c5186116e16fc0bde58d25c25f8ed`, source `sha256:c152329446f0aede4d464a1aa00cf202a9fcb039d7547caa1751bf5e06da2eff`.
- `/run/release-evidence/platform-capability.json` is still a directory; `/run/release-evidence/platform-capacity.json` and `/run/release-evidence/runtime-evidence.json` are absent. The application expects `capacity-report.json` for the capacity mount.
- All listed Docker services on `101` were healthy, but their release identity does not match candidate Git `59eb1e8db78005a2f9be1b8a808507422ffc82b8`.

This recheck adds no approval or deployment authorization. The candidate remains blocked until candidate-bound evidence is installed and the release identity is verified after the review gates pass.
