# ECS release/image provenance audit — round 8 (2026-10-05)

Read-only host and registry review. No deployment, image build, container
restart, metadata rebind, cleanup, or cutover was attempted. Raw captures are
under `docs/qa/evidence/2026-10-05-release-round8/`.

## Release identity

Both public `/releasez` endpoints returned `ready=true` and the same values:

- `release_id=ecs-3dc76c93b536`
- `release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`
- `manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`
- `image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`

This is only public identity agreement and is not proof of runtime image
agreement.

## Compose and image projection

The running project is `merchant-demo-85575f9c`, but services point at separate
candidate Compose files under `/var/lib/merchant-release-security/demo-first-install/release-85575f9c`:
API uses `candidate.compose.demo-api-3dc76c93b536.json`, UI/Ops UI use a
`dc63e0b9` Compose file, and ancillary services use additional files (the
allowlisted projection is in `compose-projection.txt`).

The image RepoDigest set observed on 101 is:

| role | RepoDigest suffix | OCI revision |
| --- | --- | --- |
| API | `8b893877…` | `fa6beb91…` |
| worker | `2aca1cf7…` | `fa6beb91…` |
| merchant UI | `111c918f…` | `dc63e0b9…` |
| Ops UI | `a904814f…` | `dc63e0b9…` |
| payment gateway | `af8f6a4e…` | `0fa18b78…` |
| pilot gateway | `5a367cb6…` | `3567df1…` |

Full RepoDigests, image labels, container IDs and projects are captured in
`host-image-repodigests-labels.txt`. This is a mixed provenance runtime.

## Candidate and registry comparison

The exact old candidate manifest advertising the public image-set digest
matches only 4/6 observed application RepoDigests (UI, Ops UI, payment and
pilot). Its API and worker digests differ. The remote-baseline manifest also
matches 4/6 and is not a release candidate. Other discovered image-set files
match 0/6.

The host registry has 37 tags common to all six application repositories, each
with six manifest digests, but none is a complete match to the current six-role
runtime set. The best observed common tag is `ecs-dc63e0b9`, matching only UI and
Ops UI (2/6). The full common-tag digest inventory and comparison are in
`registry-common-tag-digests.txt`, `registry-common-tag-analysis.txt`, and
`round8-match-analysis.txt`.

## Decision

`BLOCKED_IMAGE_SET_DRIFT` remains. No complete, reviewed, candidate-bound
image set matches current runtime, and the Compose project is assembled from
multiple per-service candidate files. A safe repair requires one immutable
six-role (plus upstream migration/clamav/database/redis) manifest, matching
rendered Compose and candidate identity, protected isolated-runtime evidence,
and post-cutover `/releasez`/health evidence bound to that same set.
