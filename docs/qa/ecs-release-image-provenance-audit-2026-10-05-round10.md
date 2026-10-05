# ECS release/image provenance audit — round 10 (2026-10-05)

Fresh read-only comparison of production identity, 101 runtime images, local
registry tags, and all discovered candidate image-set manifests. No deployment,
rebind, build, restart, cleanup, or cutover was attempted.

Both public `/releasez` probes still return `ready=true` and identical identity:
`ecs-3dc76c93b536`, Git `3dc76c93b53652190f03454b305c86931e5f72ae`, manifest
`d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`, and
image-set `sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`.

The 101 runtime RepoDigest roles remain API `8b893877…`, worker `2aca1cf7…`,
UI `111c918f…`, Ops UI `a904814f…`, payment `af8f6a4e…`, and pilot `5a367cb6…`.
The six discovered image-set manifests have a best match of **4/6**, the old
`candidate.image-set.demo-3dc76c93b536.json` (UI, Ops UI, payment, pilot); API
and worker differ. The latest source candidate remains SHA
`59eb1e8db78005a2f9be1b8a808507422ffc82b8` and has no complete image-set.

The registry still exposes 37 tags common to all six application repositories,
but no evidence of a candidate-bound six-role set matching current runtime.
Raw captures and comparison are in
`docs/qa/evidence/2026-10-05-release-round10/`.

Decision: `BLOCKED_IMAGE_SET_DRIFT`. A complete immutable image set and matching
candidate-bound Compose/release identity are still absent; deployment and
metadata rebind remain prohibited.
