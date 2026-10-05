# ECS release/image provenance audit — round 4 (2026-10-05)

Read-only audit performed at 2026-10-04T22:27:15Z. The probe used public
`/releasez` endpoints and the allowlisted Docker identity projection on SSH
host `101`. It did not mutate the host, images, metadata, evidence files,
containers, routing, or release controls.

## Public release identity

Both `https://yxsona.com/releasez` and `https://ops.yxsona.com/releasez`
returned HTTP 200 with the same identity:

| field | observed value |
| --- | --- |
| `release_id` | `ecs-3dc76c93b536` |
| `release_git_sha` | `3dc76c93b53652190f03454b305c86931e5f72ae` |
| `manifest_sha256` | `d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89` |
| `image_set_digest` | `sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62` |

The response was `ready=true`; this only proves the public endpoint is
responding and does not establish image-set equivalence.

## 101 immutable runtime projection

The running application image and revision projection remains mixed:

| services | image reference | OCI revision |
| --- | --- | --- |
| API and API replica | `merchant-api@sha256:8b8938779b073a8554ba0a48d86067e96e951b53fd3c065ad072fce8319479e9` | `fa6beb91fdb81f4ebb2b676be3fa97baa7fb0ed5` |
| six workers | `merchant-worker@sha256:2aca1cf726dfd110dbffca1e90a764794481dbe5db4a45b982435a5f8ba791ce` | `fa6beb91fdb81f4ebb2b676be3fa97baa7fb0ed5` |
| merchant UI | `merchant-ui@sha256:111c918ffc4996a3a770bb352ec670edecb4845ba749f2db4cee5ad4eeab32c9` | `dc63e0b9e05bf4761cd3fde7b1fa28c329e151eb` |
| ops UI | `merchant-ops-ui@sha256:a904814fd5a152af82509b51ac885ac60498050cd7a03b2e121922e1f31995b0` | `dc63e0b9e05bf4761cd3fde7b1fa28c329e151eb` |
| payment gateway | `payment-gateway@sha256:af8f6a4e3501e613731012130cda6d714d2cd4560f0bd9452e825a485a807f81` | `0fa18b78a65de8c5b07f09488f416a6ed08bfe08` |
| pilot gateway | prior round identity `3567df1e2894…`; the allowlisted SSH projection timed out before this row was emitted | `3567df1e2894aaf45974464f2ecad50b187971ab` (prior round) |

The containers are attached to Compose project `merchant-demo-85575f9c`, while
the public release endpoint advertises `ecs-3dc76c93b536`. No one immutable
image-set identity covers all application services.

## Candidate binding and preflight

The newest reviewed candidate package,
`artifacts/deployment-candidates/ecs-20261004T214923Z`, binds only source,
comparison-manifest, and sync-plan hashes:

```text
git_sha=59eb1e8db78005a2f9be1b8a808507422ffc82b8
source_sha256=sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1
comparison_manifest_sha256=sha256:dcbb2f0a2527a7bab6791f0669abdd25d875380d324da16cd6190c480e809a44
sync_plan_sha256=sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6
```

It has no complete immutable candidate image-set manifest or protected
cutover preflight binding every running service. Its Git SHA also differs from
the public release SHA. The older exact-SHA package
`artifacts/deployment-candidates/ecs-20261001T035344Z-3dc76c93b536/` does carry
an image-set manifest with the public four fields, but it still does not match
the host: it expects API digest `85bc925f…` (host `8b893877…`), worker digest
`1710b17b…` (host `2aca1cf7…`), and a PG17 migration image while the running
database is PostgreSQL 16. Its pilot gateway digest is `5a367cb6…`, matching
the prior-round pilot identity, but that does not repair the API/worker/DB
drift. Newer packages with other Git SHAs likewise do not match the live
identity. Therefore no safe complete rebind or deployment opportunity is
present.

## Decision

`BLOCKED_IMAGE_SET_DRIFT` remains in force. A metadata rebind would hide the
observed immutable image mismatch and was intentionally not attempted. A
future repair must first supply a reviewed candidate image-set manifest,
protected 101 preflight, consistent container identities, and post-cutover
public `/releasez` evidence. This audit does not authorize deployment.
