# Capability/capacity evidence audit — 2026-10-05 (round 6)

This is a read-only candidate-bound evidence attempt for the current local candidate:

- candidate Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- candidate source SHA: `sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
- candidate identity file: `artifacts/deployment-candidates/ecs-20261004T214923Z/candidate-identity.txt`
- candidate release id used for planning only: `release-59eb1e8db780`

No signed or runtime evidence artifact was created or installed. The release id above is derived for a network-free plan only; it is not a deployed release identity.

## Authoritative host observations

At `101`, a read-only inventory reported:

```
/run/release-evidence/platform-capability.json type=directory uid=0 gid=0 mode=755 size=40
/run/release-evidence/capacity-report.json MISSING
/var/lib/merchant-release-security/runtime-evidence MISSING
```

The public `/api/healthz` response still reports both `productionEvidence.capability` and `productionEvidence.capacity` as `blocked`, with `CAPABILITY_EVIDENCE_PATH cannot be read` and `CAPACITY_REPORT_PATH cannot be read`. `/releasez` reports the live identity `ecs-3dc76c93b536`, Git `3dc76c93b53652190f03454b305c86931e5f72ae`, manifest `d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`, and image set `sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`; none matches the local candidate.

The host search found only source-archive copies of capture/attester code and historical artifacts. It did not expose a current-release, candidate-bound capability or capacity source.

## Capability attempt

The reviewed manual capability capture requires all of the following before any bearer-bearing request: the exact deployed candidate identity, a bearer token, target and isolation workspace IDs, expected candidate Git/manifest/image bindings, and a protected output directory. None of those candidate runtime inputs is available for `59eb1e8…`; the live API is a different release and the host has no candidate API container identity to use with the Docker transport helper. The protected signer also requires the host trust key and an unsigned capture produced from that exact runtime.

The capture was therefore not run against production and no unsigned or signed capability file was created. Reusing the live release, `{}` directory, a historical manual report, or a fixture would violate release and evidence binding.

## Capacity attempt

The network-free planner was run successfully for the candidate-bound profile `pilot_50` with an isolated-preproduction target placeholder. Its output is [capacity-plan-59eb1e8db780-20261005.json](capacity-plan-59eb1e8db780-20261005.json), SHA-256 `sha256:854859a3b9cf6c5e6dbb44bb8d6c3ef63d109b9c3017aefd339bb2b37ee69f04`.

The plan explicitly says `network_activity=false`, `target_kind=isolated_preproduction`, and `produces_cloud_gate_evidence=false`. It cannot satisfy the production capacity gate. The capture path requires a real isolated-preproduction HTTPS endpoint, the matching candidate `/releasez`, a protected workload token, the exact full candidate Git SHA, and `CAPACITY_CAPTURE_CONFIRM=release-59eb1e8db780` before sending load.

As a safety check, attempting `capture` against `https://yxsona.com` was rejected by the script with `capacity capture is forbidden against the production domains; use an isolated preproduction environment` (exit 2). No network load was sent and no output file was created.

## Decision

`CAPABILITY_EVIDENCE=BLOCKED_CANDIDATE_RUNTIME_INPUTS` and `CAPACITY_EVIDENCE=BLOCKED_ISOLATED_PREPRODUCTION_INPUTS`. This round produced only a network-free plan and read-only host/runtime observations. It did not alter containers, volumes, evidence mounts, credentials, release metadata, or production data.

Required next inputs are external: a fully reviewed and identity-bound candidate image/runtime, isolated-preproduction endpoint and workload credentials, authorized capability canary workspace credentials, and the protected host trust/signing handoff. Until those exist, production remains NO-GO.
