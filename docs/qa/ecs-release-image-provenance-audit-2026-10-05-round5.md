# ECS release/image provenance audit — round 5 (2026-10-04)

This is a read-only refresh from the public release probes and the fixed
read-only inventory program against SSH host `101`. No files, containers,
images, routing, release metadata, evidence, or deployment controls were
mutated. The inventory program only returns hashes and identity projections;
it does not return environment values, credentials, or full Docker inspect
objects.

## Public identity

At `2026-10-04T22:33:39Z`, both public endpoints returned HTTP 200 and the
same ready identity:

```text
release_id=ecs-3dc76c93b536
release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae
manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89
image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62
ready=true
```

The `/releasez` response is a public identity observation. It does not prove
that the running containers use the advertised image set.

## 101 read-only inventory

The fixed inventory completed with exit code `2` (expected for a blocking
inventory) and produced schema `ecs-demo-254-host-inventory/2` for project
`merchant-demo-85575f9c`:

```text
observed_at=2026-10-04T22:33:25.490Z
container_count=73
inventory_sha256=e236760269cec7c5a0282529ddf433d8d3263a368a8d0f3a66d49f0ace54c73b
expected_demo_role_containers=15
unclassified_external_consumers=58
```

The blocking findings include duplicate `api` services, two exited/unhealthy
`api` containers, and 58 containers outside the expected role set. Because
the fixed registry fingerprint did not match the observed registry projection,
the registry was also classified as an unclassified external consumer. This
is a topology/provenance blocker, not an authorization to clean up or restart
anything.

For the running application roles, the observed image IDs were:

| role | observed image ID | expected image digest from the exact-SHA candidate |
| --- | --- | --- |
| api / api-replica | `sha256:73b10e4e4df2b981f2e170ee8d89bd7097ec719bb69d3b56b2de2893b463cbee` | `sha256:85bc925feba956e976dbd4f548a1202008cca9c6836402e75c391c0625cc68e9` |
| workers (running six-role set) | `sha256:5cd4126edb9c2cdbc29dcb6827eba4c83ede59e1ac7522a550364e546506fd13` | `sha256:1710b17b8b8ed69fed412e120615aef4b3daeafe5594832cb15404cdbf90300a` |
| merchant UI | `sha256:73ae01ec75a4d328a57366105bb1b5c04a4247acbaa1e7b9dc97de0c13cc806c` | `sha256:111c918ffc4996a3a770bb352ec670edecb4845ba749f2db4cee5ad4eeab32c9` |
| ops UI | `sha256:c7de9bca4618e82fcc2776f904615d414c367f4eec24cc0a7afb8f2b7f46105c` | `sha256:a904814fd5a152af82509b51ac885ac60498050cd7a03b2e121922e1f31995b0` |
| payment gateway | `sha256:68d42b090416f160cf4e3b00f28720db345f0e09ca9e6ca95af599680f7a87f9` | `sha256:af8f6a4e3501e613731012130cda6d714d2cd4560f0bd9452e825a485a807f81` |
| pilot gateway | `sha256:cdbbaa6fdd5aa351c7e0ff3404ee068454f2ec0de9537d6d767456a54b8b03de` | `sha256:5a367cb6236b949816eaaafeb6d7fd3f7ca50879579510faa5c2796d0dd9513b` |

Every compared application role differs from the exact-SHA candidate image
set. PostgreSQL is observed as a running `postgres:16-alpine` container while
the candidate manifest requires a PG17 migration image and separately lists
the PostgreSQL 16 runtime. This must be resolved in a reviewed, internally
consistent image-set manifest before any cutover consideration.

## Candidate binding

The newest reviewed source candidate (`ecs-20261004T214923Z`) binds:

```text
git_sha=59eb1e8db78005a2f9be1b8a808507422ffc82b8
source_sha256=sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1
comparison_manifest_sha256=sha256:dcbb2f0a2527a7bab6791f0669abdd25d875380d324da16cd6190c480e809a44
sync_plan_sha256=sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6
```

It has no complete immutable image-set manifest or protected per-service
preflight binding. Its Git SHA differs from the public release, and the exact
SHA package for the public release does not match the 101 image IDs above.
The source-only candidate therefore cannot be treated as a deployable
provenance bundle.

## Decision

`BLOCKED_IMAGE_SET_DRIFT` remains in force. The evidence proves the public
release identity and current host drift but does not establish a candidate
image build, a consistent 101 runtime, or a safe rebind. No metadata rebind,
image replacement, restart, cleanup, or deployment was attempted.

Required next evidence is a reviewed candidate image-set manifest covering
every service (including database compatibility), a protected 101 preflight
that observes those exact immutable IDs in an isolated candidate runtime, and
post-cutover `/releasez` plus health/canary evidence bound to the same release
identity.
