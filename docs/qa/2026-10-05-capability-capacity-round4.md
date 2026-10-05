# Capability/capacity evidence audit — 2026-10-05 round 4

This audit is read-only and records the current 101 runtime and the candidate
release identity visible from the working tree. No production evidence file was
created, copied, or installed.

## Current release identity

`GET https://yxsona.com/api/releasez` returned HTTP 200 with:

- release ID: `ecs-3dc76c93b536`
- release Git SHA: `3dc76c93b53652190f03454b305c86931e5f72ae`
- rendered manifest SHA-256: `d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`
- image-set digest: `sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`
- `ready: true`

`GET https://yxsona.com/api/healthz` still reports both production evidence
checks as blocked: `CAPABILITY_EVIDENCE_PATH cannot be read` and
`CAPACITY_REPORT_PATH cannot be read`.

## Host-side evidence paths

Both API containers mount the demo-first-install placeholders:

```
/var/lib/merchant-release-security/demo-first-install/release-85575f9c/capability.placeholder.json
  -> /run/release-evidence/platform-capability.json (read-only)
/var/lib/merchant-release-security/demo-first-install/release-85575f9c/capacity.placeholder.json
  -> /run/release-evidence/capacity-report.json (read-only)
```

Inside both containers, each target is a root-owned `0600` regular file of
three bytes (`7b 7d 0a`, SHA-256
`ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356`) and
therefore is not readable by the API process. The two files are the `{}`
placeholder, not release-bound evidence. There is no signed source artifact or
release-scoped runtime handoff mounted for `ecs-3dc76c93b536`.

## Capture inputs and refusal

The capability capture requires a real canary bearer token, two distinct
workspace IDs, an operator identity, and candidate-bound Git, manifest, and
image-set values. None of those protected canary credentials/transcripts are
available in this workspace, so the protected attester cannot be run.

The capacity capture requires an isolated HTTPS preproduction URL,
`CAPACITY_CAPTURE_TARGET_KIND=isolated_preproduction`, a release-bound workload
token and expected full Git SHA. The only reachable HTTPS URL is the production
domain; running the capture script with it was refused by the script:

```
capacity capture is forbidden against the production domains; use an isolated preproduction environment
```

This is a required safety refusal. Production health and `/releasez ready=true`
are not capacity evidence, and a historical `no_load` declaration or source
example cannot satisfy the current release gate.

## Decision

Capability and capacity remain **blocked** for the current release. A valid
next attempt requires an isolated HTTPS target running the reviewed candidate,
real canary/workload credentials and observations, protected signing with the
host trust key, and installation of both exact release-bound source artifacts
and runtime handoffs. No production state changed during this audit.
