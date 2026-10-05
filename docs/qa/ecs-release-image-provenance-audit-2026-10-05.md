# ECS release/image provenance audit (2026-10-05)

This is a read-only audit of the public release identity and the running Docker project on SSH target `101`. It does not authorize staging, image rebuild, container restart, or traffic cutover.

## Public and candidate identity

- `https://yxsona.com/releasez` reported `release_id=ecs-3dc76c93b536`.
- `release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`.
- `manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`.
- `image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`.
- The local candidate image manifest at `artifacts/deployment-candidates/ecs-20261001T035344Z-3dc76c93b536/candidate.image-set.demo-3dc76c93b536.json` contains the same four identity fields.

## 101 runtime observation

The expected candidate application digests were:

- API and API replica: `sha256:85bc925feba956e976dbd4f548a1202008cca9c6836402e75c391c0625cc68e9`.
- Worker set: `sha256:1710b17b8b8ed69fed412e120615aef4b3daeafe5594832cb15404cdbf90300a`.

The running project `merchant-demo-85575f9c` instead reported:

- API/API replica image reference `...merchant-api@sha256:8b8938779b073a8554ba0a48d86067e96e951b53fd3c065ad072fce8319479e9`, content image ID `sha256:73b10e4e4df2b981f2e170ee8d89bd7097ec719bb69d3b56b2de2893b463cbee`.
- Worker image reference `...merchant-worker@sha256:2aca1cf726dfd110dbffca1e90a764794481dbe5db4a45b982435a5f8ba791ce`, content image ID `sha256:5cd4126edb9c2cdbc29dcb6827eba4c83ede59e1ac7522a550364e546506fd13`.

The container labels also show mixed release provenance: API `release-fa6batch-spreadsheet`/`fa6beb91...`, workers `release-fa6batch-import`/`fa6beb91...`, UI and ops UI `ecs-dc63e0b9`/`dc63e0b9...`, payment `release-0fa18b78-review`, and pilot gateway `release-3567df1e2894-image`. The API environment advertises the public `ecs-3dc76c93b536` identity while its immutable image and release labels identify other candidates.

## Decision

`BLOCKED_IMAGE_SET_DRIFT`. A metadata rebind would make the advertised identity agree while leaving the immutable runtime images and labels mixed, so it is unsafe and was not attempted. A safe repair requires a fully reviewed candidate image set, protected preflight, and controlled cutover with post-cutover `/releasez` and container identity evidence.
