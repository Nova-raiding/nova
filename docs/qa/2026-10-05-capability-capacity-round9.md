# Capability/capacity evidence audit — 2026-10-05 (round 9)

Round 9 performed a deeper read-only check of the candidate source bundle, host evidence roots, Docker mounts, and the running API container paths. No signer was executed and no file, mount, container, volume, credential, or release metadata was changed.

## Candidate bundle

The current candidate is Git `59eb1e8db78005a2f9be1b8a808507422ffc82b8`. Its source tar contains attester/capture programs, validators, runbooks, and example schemas, but no captured capability JSON, signed manual-operations artifact, capacity cloud-gate report, runtime handoff, release-evidence bundle, or attestation output. Candidate review metadata also records missing remote counterparts for the runtime handoff and attester-related paths; those review records are not runtime evidence.

A content search over the candidate package found no current `release-59eb1e8` evidence artifact. The only capacity/capability JSON in the source bundle is example/schema material.

## Host and container evidence

The expanded host search under `/var/lib/merchant-release-security`, `/run/release-evidence`, and `/run/release-security/evidence-trust` found no file containing the candidate SHA or candidate release ID. Host historical evidence consists of other release IDs, expired declarations, fixtures, and control-install receipts.

Sanitized Docker metadata shows the running API containers use the old demo project and mount:

- `.../demo-first-install/release-85575f9c/capability.placeholder.json` → `/run/release-evidence/platform-capability.json`
- `.../demo-first-install/release-85575f9c/capacity.placeholder.json` → `/run/release-evidence/capacity-report.json`

Inside the API container, both paths are regular root-owned `0600`, 3-byte files. The application user cannot read them (`sha256sum` returns `Permission denied`). The mounted evidence-trust directory is root-owned and does not make the evidence files readable. This explains the public health response's `CAPABILITY_EVIDENCE_PATH cannot be read` and `CAPACITY_REPORT_PATH cannot be read` reasons.

Running image labels remain mixed across API, workers, merchant UI, Ops UI, payment gateway, and pilot gateway; none binds the current candidate SHA. The public `/api/releasez` remains `ecs-3dc76c93b536` and differs from the candidate.

## Decision

`CAPABILITY_EVIDENCE=BLOCKED_NO_CAPTURED_CANDIDATE_ARTIFACT`.

`CAPACITY_EVIDENCE=BLOCKED_NO_CAPTURED_CANDIDATE_ARTIFACT`.

Source code, validators, trust directories, and an installed attester are capability to produce evidence; they are not evidence. Root-owned placeholder files and historical reports cannot be reused or rebound. No candidate-bound evidence is readable in the host or container, so production remains NO-GO.
