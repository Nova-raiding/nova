# Capability/capacity evidence capture attempt — 2026-10-05

This is a read-only host-side capture attempt for the exact candidate currently under review (`release-936954d4`, Git `936954d4c5f8f0ffa76e75cd8012ad99e42699c5`). No evidence file was created or installed because the host did not expose a valid, candidate-bound source.

## Candidate binding inspected

The 101 host candidate render contains:

- release ID: `release-936954d4`
- Git SHA: `936954d4c5f8f0ffa76e75cd8012ad99c5`
- source digest: `sha256:a232bc74230d8166f3118d9d4ad6228406727430391997a5fd7f6bee142f718a`
- candidate manifest SHA: `43f6c57d114bc147e21087f3b118392460b96270ef63db908c4da18125e60b25`
- image-set digest: `sha256:254787f08e707592cd3516d99c1d1e905717ba8965584a5273049fdc86b794bb`

The candidate review capsule explicitly remains `review_only`, `deployable: false`, and `production_go: false`.

## Runtime evidence result

The host's `/run/release-evidence` state is not a readable evidence handoff:

- `/run/release-evidence/platform-capability.json` exists as a root-owned directory (`drwxr-xr-x`, size 40), so it cannot be read as a JSON regular file.
- `/run/release-evidence/capacity-report.json` does not exist.
- The directory contains no regular capability or capacity artifact beneath either path.
- The running API's `/releasez` reports a different release (`ecs-3dc76c93b536`, Git `3dc76c93b53652190f03454b305c86931e5f72ae`, manifest `d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`, image set `sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`).
- `/api/healthz` reports `productionEvidence.capability.state=blocked` with `CAPABILITY_EVIDENCE_PATH cannot be read` and `productionEvidence.capacity.state=blocked` with `CAPACITY_REPORT_PATH cannot be read`.
- The API container labels identify yet another release (`release-fa6batch-spreadsheet`, source `sha256:4289eb9e9f0d5e7bfd5b749c66f28439708fd5ac9685b272dff6aad1e359cd5e`, image revision `fa6beb91fdb81f4ebb2b676be3fa97baa7fb0ed5`). This is evidence of runtime/candidate drift, not a candidate-bound test target.

## Decision

`capture-ecs-capacity-evidence.sh capture` was not run against production or the drifted runtime. The capture script correctly forbids production domains and produces raw observations only; it cannot generate the required signed cloud-gate report. The protected capability attester also cannot run without the exact candidate provider transcripts, release binding, and host trust key. Installing a placeholder, the existing `{}` file, or a report from the old runtime would violate the release and evidence gates.

Required host-side remediation before another capture attempt:

1. Materialize the reviewed candidate and expose an isolated HTTPS preproduction target.
2. Obtain real provider exchange transcripts for all six platforms and all required operations, bound to the same release ID.
3. Run the capacity profile against that isolated target with zero mock ratios, then validate its raw metrics and human sign-off.
4. Run the protected capability attester and install both signed source artifacts and release-scoped read-only runtime handoffs.
5. Re-read both files through the API container and verify `/releasez` matches the same candidate Git, manifest and image-set identity.

No production state was changed by this attempt.

A host search found one historical capacity file at `/var/lib/merchant-release-security/evidence/release-3dc0a88e-owner-capacity-report.json`. It is a `no_load` declaration for `release-3dc0a88e-owner`, migration 242, and has `cloud_gate: false`; it is neither the reviewed release nor a load-test result and was not reused. The host also exposes repository examples under source archives, which are explicitly non-production fixtures.
