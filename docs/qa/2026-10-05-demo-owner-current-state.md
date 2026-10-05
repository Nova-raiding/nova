# 101 demo owner current-state correction

This record supersedes deployment conclusions in the earlier round2–round11
reports for this demo task. Those reports are retained as historical observations,
not current release gates or proof that the candidate has been deployed.

Fresh host observations on 2026-10-05 establish:

- The active project is `merchant-demo-85575f9c`, with 15 healthy containers.
  API and worker OCI source revision is
  `fa6beb91fdb81f4ebb2b676be3fa97baa7fb0ed5`; UI/Ops revision is
  `dc63e0b9e05bf4761cd3fde7b1fa28c329e151eb`.
- Public release `ecs-3dc76c93b536` is not the source revision of every
  component. Its manifest must be reconciled with actual container digests.
- Both runtime database roles see the same complete migration history 1–257,
  matching current SQL checksums. Current source requires migration 258.
  A new API cannot be deployed as a migration-free update.
- The applicable demo procedure is `docs/runbooks/ecs-demo-direct-deploy.md`.
  Production signing, historical rollback capsules, Windows delivery and
  customer notarization must not be substituted for this task's requirements.
  Real local stdio authentication, relay billing, migration safety and desktop
  business verification remain required.
- A fresh consistent backup was restored successfully on 101 into an isolated,
  network-disabled PostgreSQL container. Backup SHA-256:
  `37078df9009b38364701f1b0227320bf6e08f8698571ffdcaf4518f001e67996`.
  Migration history, table counts, RLS counts and runtime role safety matched.
  Migration 258 verification is a separate step; restoration alone is not
  deployment approval.
- The existing relay log refresh credential returned HTTP 401 on one real
  refresh attempt. No replacement session was produced; the refresh lock is
  retained to prevent blind replay. A new authenticated session is required.

No new deployment or full-flow success is claimed by this record. The owner
must record the frozen commit, built digests, migration result, service switch
and real desktop/local-plugin outcomes before declaring the task complete.

## Fresh demo backup and isolated restore evidence

Captured on 101 at 2026-10-05 00:56 UTC; the isolated test container was
stopped safely at 00:59:21 UTC after migration verification completed.

- Exact live source container:
  `6abd0fb584b3746cca5b3e73d21681a24ab3780fce0a46d385ffcebcd43c0980`.
  Its PostgreSQL image ID was checked before backup and reused for restoration:
  `sha256:81bd698b4594e751a3269e4dcd3e03a4a0ec0daf7b72e7aa1abd43cce9887542`.
- The PostgreSQL 16 custom-format dump used its consistent snapshot and was
  2,373,419 bytes. SHA-256:
  `37078df9009b38364701f1b0227320bf6e08f8698571ffdcaf4518f001e67996`.
  The complete migration-history text SHA-256 was
  `dd11e731e3bc1a7ecb31de2a20f6d1b0e13a7d065c537cb081b00401606310b7`.
  Source migration history was unchanged before and after capture.
- Host evidence directory:
  `/var/lib/merchant-release-security/demo-backup-restore-257-20261005T005606Z-7e1a8ff7`.
  It is root-owned mode 0700; the dump is mode 0600. Backup data, role definitions,
  restore logs and isolated credentials remain on 101. Roles were captured
  without role passwords; restoration retained ownership and ACLs.
- `pg_restore --list` and actual `pg_restore --exit-on-error` completed.
  Restored migration history 1–257 matched exactly. Both source and restored
  databases had 174 public ordinary tables and 155 tables with RLS enabled
  and forced. `merchant_app` and `merchant_ops` were neither superusers nor
  BYPASSRLS roles. These checks do not claim a same-snapshot comparison of
  every business row.
- Isolated container:
  `merchant-demo-restore-20261005t005606z-7e1a8ff7`, full ID
  `43eec070c50da2989267033ddc0ba9e02f0906a36d072a94510a1c99b91bd38a`.
  It used network `none`, no published ports, a 512 MiB memory limit, restart
  policy `no`, and new bind-mounted data beneath the evidence directory.
- The migration agent subsequently reported migration 258, both function
  signatures and seven authorization/claim behavior scenarios passing on
  this restored database, with all behavior-test writes rolled back.
  Its complete 1–258 name/checksum comparison passed for both runtime roles.
  This is isolated validation, not evidence that live migration 258 ran.
- Before stopping, the exact container ID, name, purpose label, network and
  both protected-directory mounts were checked. `docker stop --time 30` then
  completed; inspect confirmed `exited`, exit code 0. No container, backup,
  volume or bind-mounted data was deleted. `result.json` and `stop-result.json`
  remain in the protected directory.

This establishes a fresh demo backup restoration drill. It is not a signed
production backup attestation, a live migration, or a deployment-success claim.
