# ECS release/image provenance audit — round 6 (2026-10-05)

Read-only evidence capture from the local owner workspace. No host mutation,
image build, metadata rebind, restart, cutover, or deployment was attempted.
Capture files are under `docs/qa/evidence/2026-10-05-release-round6/`.

## Public identity

At capture time both public release probes returned HTTP 200 and `ready=true`:

- `release_id=ecs-3dc76c93b536`
- `release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`
- `manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`
- `image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`

The response bodies and their SHA-256 values are recorded in the capture
folder. The two probes agree with each other but only advertise release
identity; they do not prove that every running container uses one image set.

## Current 101 runtime projection

The allowlisted Docker projection recorded these application image IDs and OCI
revisions:

| role | image ID | OCI revision |
| --- | --- | --- |
| API and API replica | `sha256:73b10e4e4df2b981f2e170ee8d89bd7097ec719bb69d3b56b2de2893b463cbee` | `fa6beb91fdb81f4ebb2b676be3fa97baa7fb0ed5` |
| worker services | `sha256:5cd4126edb9c2cdbc29dcb6827eba4c83ede59e1ac7522a550364e546506fd13` | `fa6beb91fdb81f4ebb2b676be3fa97baa7fb0ed5` |
| merchant UI | `sha256:73ae01ec75a4d328a57366105bb1b5c04a4247acbaa1e7b9dc97de0c13cc806c` | `dc63e0b9e05bf4761cd3fde7b1fa28c329e151eb` |
| ops UI | `sha256:c7de9bca4618e82fcc2776f904615d414c367f4eec24cc0a7afb8f2b7f46105c` | `dc63e0b9e05bf4761cd3fde7b1fa28c329e151eb` |
| payment gateway | `sha256:68d42b090416f160cf4e3b00f28720db345f0e09ca9e6ca95af599680f7a87f9` | `0fa18b78a65de8c5b07f09488f416a6ed08bfe08` |
| pilot gateway | `sha256:cdbbaa6fdd5aa351c7e0ff3404ee068454f2ec0de9537d6d767456a54b8b03de` | `3567df1e2894aaf45974464f2ecad50b187971ab` |

The runtime therefore remains a mixed provenance set. The public release
identity does not match the OCI revisions of the application images.

## Candidate evidence

The newest reviewed source candidate at
`artifacts/deployment-candidates/ecs-20261004T214923Z` binds:

- `git_sha=59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- `source_sha256=sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
- comparison and sync-plan hashes from its `candidate-identity.txt`

That candidate has no complete immutable image-set manifest, per-service
Docker image digests, rendered Compose, or protected image inventory. The older
`ecs-20261001T035344Z-3dc76c93b536` package has an image-set JSON, but its
expected API/worker digests are not the current 101 image IDs and it includes a
PG17 migration image. It cannot be used as a current runtime equivalence proof.

## Decision

`BLOCKED_IMAGE_SET_DRIFT`. The current release and candidate source SHA differ,
and the running application images are mixed across unrelated revisions. A
metadata rebind would conceal the mismatch, so no rebind, restart, cleanup,
image replacement, staging, or deployment was attempted.

Before any cutover consideration, obtain a reviewed immutable candidate
image-set manifest covering all required services and upstream images, a
protected per-service image-ID projection from an isolated candidate runtime,
matching rendered Compose and release metadata, and post-cutover `/releasez`
and health evidence bound to the same release identity.

## Registry check

The host-local registry is readable and exposes many historical tags. The
application role tags are not a single candidate namespace: API and worker
include `release-fa6beb91`, while UI, ops UI, payment and pilot gateway do not
expose that tag. The currently observed role-specific tags correspond to
separate revisions (`fa6beb91`, `dc63e0b9`, `0fa18b78`, and `3567df1`). The
registry catalog/tag response is captured in `registry-tags.txt`; it provides
inventory only and is not an authorization to select or repoint tags.
