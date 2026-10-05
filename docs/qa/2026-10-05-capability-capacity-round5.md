# Capability/capacity evidence audit — 2026-10-05 (round 5)

This is a read-only audit of the currently configured ECS host (`101`). It does
not create, copy, sign, or replace production evidence. A health response is
not treated as evidence readiness.

## Current release identity

At the time of this audit, `GET https://yxsona.com/releasez` returned HTTP 200
with the following release identity:

```text
release_id=ecs-3dc76c93b536
release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae
manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89
image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62
ready=true
```

The candidate worktree is `59eb1e8db78005a2f9be1b8a808507422ffc82b8`; it is
not the running release. No candidate image-set digest or candidate manifest
that matches the running release was available in this workspace.

## Host evidence boundary

The host's active API containers are the `merchant-demo-85575f9c` stack. Both
API replicas mount the old demo placeholders:

```text
/var/lib/merchant-release-security/demo-first-install/release-85575f9c/capability.placeholder.json:/run/release-evidence/platform-capability.json:ro
/var/lib/merchant-release-security/demo-first-install/release-85575f9c/capacity.placeholder.json:/run/release-evidence/capacity-report.json:ro
```

Each source is root-owned `0600`, three bytes, and contains exactly `{}`. The
host runtime evidence root `/var/lib/merchant-release-security/runtime-evidence`
does not exist. Because the source paths are not valid release-scoped evidence,
the Docker bind target for `platform-capability.json` is a directory and the
capacity target is absent. This is the concrete reason the API reports both
evidence paths as unreadable.

The same state is visible through the public health contract (HTTP 200 does not
override the two readiness blockers):

```json
{
  "productionEvidence": {
    "capability": {"state":"blocked","configured":false,"reasons":["CAPABILITY_EVIDENCE_PATH cannot be read"]},
    "capacity": {"state":"blocked","configured":false,"reasons":["CAPACITY_REPORT_PATH cannot be read"]}
  }
}
```

The protected capability attester and trust material are present (`node`
v22.23.2, root-only private-key path, public key and key ID), but there is no
candidate-bound input to sign. The attester requires six real platform
transcripts, exact candidate release/image/manifest/Git/nonce binding, and
matching negative-path receipts. No such transcript bundle or candidate
release is present. Capacity has no host attester; its cloud gate requires a
real HTTPS load run with zero mock ratios, tenant isolation, fault and steady
state observations, sign-off, and an unexpired release-bound report.

## Outcome

```text
capability: BLOCKED — no candidate-bound authenticated capture/transcript or
             matching running release; do not invoke the signer or handoff
capacity:   BLOCKED — no real cloud-gate observations/report and no
             release-scoped runtime evidence directory
```

The correct next action is to stage the reviewed candidate on the host, bind a
new isolated candidate API image, run the authenticated read-only manual
capture with target and foreign workspace credentials, run the protected
attester, and perform the release-scoped runtime handoff. Capacity must be
captured separately against the same candidate and validated with
`--require-cloud-gate`. Copying `{}`, using an old demo report, or signing
locally would violate the evidence gates and was deliberately not attempted.
