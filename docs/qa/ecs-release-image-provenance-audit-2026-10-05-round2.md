# ECS release/image provenance audit — round 2 (2026-10-05)

Read-only review from the local owner workspace at 2026-10-04T22:22Z. No host mutation, metadata rebind, image build, restart, or cutover was attempted.

## Public identity and health

Both `https://yxsona.com/releasez` and `https://ops.yxsona.com/releasez` returned HTTP 200 and the same advertised identity:

- `release_id=ecs-3dc76c93b536`
- `release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`
- `manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`
- `image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`

Both health endpoints returned HTTP 200 and `status=ok`, but production evidence remains blocked: `capability.state=blocked` and `capacity.state=blocked`, each because its configured evidence path cannot be read. Health readiness does not constitute release approval.

## 101 runtime identity

The 15 `merchant-demo-85575f9c` containers were running and healthy. Host `/` reported 20,828,721,152 bytes free. The immutable runtime identities remain mixed:

| component | running image digest | release/revision label |
|---|---|---|
| API + API replica | `merchant-api@sha256:8b893877…` (content `sha256:73b10e4e…`) | `release-fa6batch-spreadsheet`, revision `fa6beb91…` |
| workers | `merchant-worker@sha256:2aca1cf7…` (content `sha256:5cd4126e…`) | `release-fa6batch-import`, revision `fa6beb91…` |
| merchant UI | `merchant-ui@sha256:111c918f…` | `ecs-dc63e0b9`, revision `dc63e0b9…` |
| ops UI | `merchant-ops-ui@sha256:a904814f…` | `ecs-dc63e0b9`, revision `dc63e0b9…` |
| payment gateway | `payment-gateway@sha256:af8f6a4e…` | `release-0fa18b78-review`, revision `0fa18b78…` |
| pilot gateway | `pilot-gateway@sha256:5a367cb6…` | `release-3567df1e2894-image`, revision `3567df1…` |

The Compose project path is `release-85575f9c`, while the API environment advertises the public `ecs-3dc76c93b536` identity. This is an identity/image mismatch, not a single candidate runtime.

## Candidate and preflight review

The local exact candidate at `artifacts/deployment-candidates/ecs-20261001T035344Z-3dc76c93b536/` has the advertised four identity fields and expected API/worker digests, but those expected digests are not the running digests above. The newer `ecs-20261004T214923Z` package has source/new-file/protected review artifacts and a 401-file confirmation for git SHA `59eb1e8b…`, but no complete candidate image-set manifest or protected cutover preflight binding all services to one immutable image set. No trustworthy complete candidate set was found that is both reviewed and equivalent to current runtime dependencies.

Decision: `BLOCKED_IMAGE_SET_DRIFT`. Rebinding metadata would conceal the immutable image mismatch and was not attempted. A safe repair still requires a fully reviewed candidate image set, protected preflight, controlled cutover, and post-cutover `/releasez` plus container identity evidence.
