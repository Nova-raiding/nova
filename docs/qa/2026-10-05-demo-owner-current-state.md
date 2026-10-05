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
