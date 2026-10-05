# ECS release/image provenance audit — round 9 (2026-10-05)

This was a fresh read-only check of public identity, Compose labels, image
RepoDigests, registry manifests, and local candidate manifests. No deployment,
rebind, build, restart, cleanup, or cutover was attempted.

## Current identity

`https://yxsona.com/releasez` and `https://ops.yxsona.com/releasez` still return
HTTP 200, `ready=true`, and the same identity:

- `release_id=ecs-3dc76c93b536`
- `release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`
- `manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`
- `image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`

The latest local source candidate remains `ecs-20261004T214923Z`,
`git_sha=59eb1e8db78005a2f9be1b8a808507422ffc82b8`; it has no complete
candidate image-set manifest.

## Runtime and candidate comparison

101 is still running a mixed image set. Current immutable RepoDigest suffixes
are API `8b893877…`, worker `2aca1cf7…`, merchant UI `111c918f…`, Ops UI
`a904814f…`, payment `af8f6a4e…`, and pilot `5a367cb6…`.

The public-digest candidate manifest `candidate.image-set.demo-3dc76c93b536.json`
matches only four of six current RepoDigests (UI, Ops UI, payment, pilot); its
API and worker digests differ. The remote-baseline manifest also matches four
of six. Other discovered image-set files match zero of six. The complete role
matrix is in `match-analysis.txt`.

## Registry and Compose

The host registry exposes 37 tags common to all six application repositories,
with six manifest digests per tag. No common tag matches the six-role runtime;
the best is `ecs-dc63e0b9`, matching only UI and Ops UI (2/6). Compose labels
show the runtime project assembled from several per-service candidate files,
including the API `candidate.compose.demo-api-3dc76c93b536.json` and separate
`dc63e0b9` UI files. Raw projections are in
`host-compose-image-projection.txt`, `registry-common-tag-digests.txt`, and
`registry-tags-raw.jsonl`.

## Decision

`BLOCKED_IMAGE_SET_DRIFT` remains. No complete immutable image set matches the
current runtime or the latest candidate identity. A safe repair requires a
single reviewed manifest covering every required image, matching rendered
Compose and candidate SHA, protected isolated-runtime evidence, and
post-cutover identity/health evidence bound to that exact set.
