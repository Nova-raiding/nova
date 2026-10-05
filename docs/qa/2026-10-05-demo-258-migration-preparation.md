# Demo 257 → 258 migration evidence

This audit covers the 101 demo only. No online database was changed by this task.

- Migration 258 SHA-256: `d2b2af238582d087c50bfd11f75f5e98c39adbd2890128d363e62970f1cc6ab7`.
- It adds the eight-argument `settle_knowledge_generation_claim` overload and its `merchant_app` execute grant; it preserves the seven-argument function from 250 and performs no table/data rewrite.
- `npm run test:pg16-migration-compatibility` passed after the test was corrected to use `release-metadata.json.sourceMigrationVersion` (258). Previously this test stopped at 257 despite loading the current migration list.
- The corrected test applies 1–257, captures the old seven-argument function definition, applies 258, proves the old definition is unchanged, and compares every migration version/name/checksum through 258 for both runtime roles.
- Real PG16 calls as `merchant_app` reject missing usage evidence, pending cost, unrelated physical attempt, wrong provider request, wrong claim nonce, and cross-workspace access. Settled cost-bearing receipts with the exact attempt UUID or physical idempotency key close the claim. State and terminal timestamp assertions are included. Final run: 1 passed, 13.92 seconds.

## Restored 101 database trial

Runtime owner supplied a fresh custom-format backup and successful isolated PG16 restore of the current 257 database. This supersedes the old 254→255 restore evidence for this demo transition.

- Protected directory: `/var/lib/merchant-release-security/demo-backup-restore-257-20261005T005606Z-7e1a8ff7`.
- Dump SHA-256 reported by runtime agent: `37078df9009b38364701f1b0227320bf6e08f8698571ffdcaf4518f001e67996` (2,373,419 bytes).
- Isolated container: `merchant-demo-restore-20261005t005606z-7e1a8ff7`.
- Independently checked complete container ID: `43eec070c50da2989267033ddc0ba9e02f0906a36d072a94510a1c99b91bd38a`; network mode `none`.
- Before applying 258, compared every restored 1–257 version/name/checksum to the current local SQL inside the migration transaction. Applied 258 under advisory transaction lock `731942851`, then inserted its exact migration identity atomically. Exit status 0.
- Both seven/eight-argument functions remain and both grant execute to `merchant_app`; both runtime roles read 258 migration rows with max version 258.
- Repeated the seven evidence/identity scenarios above in the restored database using `merchant_app`. All passed. Each scenario rolled back its business fixture, leaving no test business rows.

## Owner execution inputs

`evidence/2026-10-05-demo-migration-258/apply-258.sql` is a concrete minimal transaction for owner review. SHA-256: `3dbc4a3650cc6385f37d7ae7bee2ccaa51b4c227dfbb6c611cb8a959302fd483`. It embeds all 258 expected identities, rejects any source chain other than exact 1–257, applies the unchanged migration SQL, records only row 258, verifies the complete resulting chain, and commits. A repeat invocation intentionally fails the source-prefix guard. It adds a 15-second lock timeout and final full-chain check to the successfully trialled transaction.

After confirming the online demo container identity, retained backup, and all replacement services, the owner can stream this reviewed SQL via `ssh 101` into the exact demo Postgres container's `psql -X -v ON_ERROR_STOP=1`, using that container's existing schema-owner connection. Do not print credential environment values. Recheck the full chain via API `DATABASE_URL` and `OPS_DATABASE_URL` before switching all API/worker consumers.

The old function staying compatible does **not** prove that old 257 binaries pass readiness against a 258 database: strict migration checks may reject the new tail. Treat recovery as forward-only at schema 258; do not claim the old image is a tested rollback target. Production signed-bridge requirements are not presented as demo blockers. This task does not authorize or assert production release success.
