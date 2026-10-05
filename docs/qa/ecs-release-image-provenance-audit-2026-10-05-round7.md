# ECS release/image provenance audit — round 7 (2026-10-05)

Read-only repeat of the release/image check. No image build, container
restart, metadata rebind, staging, cutover, cleanup, or deployment was run.
Raw captures are under `docs/qa/evidence/2026-10-05-release-round7/`.

## Release identity

Both `https://yxsona.com/releasez` and `https://ops.yxsona.com/releasez`
returned HTTP 200 with `ready=true` and the same identity:

- `release_id=ecs-3dc76c93b536`
- `release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`
- `manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`
- `image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`

The agreement is only between the public identity endpoints. It is not
runtime image equivalence evidence.

## Runtime provenance

The 101 Docker projection is unchanged from round 6:

- API and replica: image `sha256:73b10e4e…`, OCI revision `fa6beb91…`
- All workers: image `sha256:5cd4126e…`, OCI revision `fa6beb91…`
- Merchant UI: image `sha256:73ae01ec…`, OCI revision `dc63e0b9…`
- Ops UI: image `sha256:c7de9bca…`, OCI revision `dc63e0b9…`
- Payment gateway: image `sha256:68d42b09…`, OCI revision `0fa18b78…`
- Pilot gateway: image `sha256:cdbbaa6f…`, OCI revision `3567df1…`

The full IDs, container IDs, labels and registry container are in
`host-image-labels.txt`. Application services remain a mixed provenance set.

## Candidate image-set and registry checks

Only six candidate image-set JSON files were found in the deployment-candidate
artifacts. A normalized role comparison (accepting both `api`/`merchant-api`
and equivalent worker/UI role names) found **zero candidate manifest role
matches** against the observed API, worker, UI, Ops UI, payment and pilot image
IDs. The machine-readable result is `candidate-image-set-match.txt`.

The registry tag capture remains historical and heterogeneous. It does not
contain one reviewed tag set covering all observed service revisions. Registry
inventory is not treated as deployment authorization.

## Decision

`BLOCKED_IMAGE_SET_DRIFT` remains in force. The public release identity is
stable, but the running image IDs and OCI revisions are mixed and no reviewed
candidate image-set matches even one normalized runtime role. A safe repair
still requires a complete immutable candidate image-set manifest, protected
per-service image-ID evidence from an isolated candidate runtime, matching
Compose/release metadata, and post-cutover identity and health evidence.
