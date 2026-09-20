import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner, type Migration } from './migration.js'
import { PostgresStorageQuotaRepository } from './storage-quota-repository.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

/** The version the per-object reservation key landed in; 231 is the repair. */
const LEGACY_KEY_VERSION = 230
const REPAIR_VERSION = 231

/** The tables migration 231 has to read or write around FORCE ROW LEVEL SECURITY. */
const QUOTA_TABLES = ['asset_scan_receipts', 'business_entity_snapshots', 'storage_quota_reservations', 'workspace_storage_quotas'] as const

const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

const appConnection = (base: URL, database: string) => connection(
  base,
  database,
  process.env.STORAGE_QUOTA_APP_DATABASE_USER ?? 'merchant_app',
  process.env.STORAGE_QUOTA_APP_DATABASE_PASSWORD ?? 'merchant_app_local_only',
)

interface ScratchFixture {
  admin: Pool
  database: Pool
  databaseName: string
  migrations: readonly Migration[]
  workspaceId: string
  /** A tenant-runtime pool for the scratch database. The caller closes it. */
  appPool: () => Pool
}

/**
 * A scratch database holding the release chain up to the version the fix
 * repairs, so the upgrade path under test is the real one: rows written by the
 * older code are present before migration 231 runs, exactly as they are on a
 * database that has already served traffic.
 */
async function withUpgradeFixture(body: (fixture: ScratchFixture) => Promise<void>): Promise<void> {
  const base = new URL(databaseUrlValue!)
  const databaseName = `release_231_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: base.toString() })
  let database: Pool | undefined
  let primaryFailure: unknown
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    database = new Pool({ connectionString: connection(base, databaseName) })
    const migrations = await loadMigrations()
    await new MigrationRunner(database, migrations.filter(migration => migration.version <= LEGACY_KEY_VERSION)).run()
    await body({
      admin,
      database,
      databaseName,
      migrations,
      workspaceId: `ws_quota_231_${randomUUID().replaceAll('-', '')}`,
      appPool: () => new Pool({ connectionString: appConnection(base, databaseName), max: 2 }),
    })
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    await withPostgresFixtureCleanup(async () => {
      await database?.end()
      await dropDrainedPostgresFixture(admin, databaseName)
    }, primaryFailure, [
      () => admin.end(),
    ])
  }
}

/** A settled reservation in the pre-per-object key shape `asset:<assetId>`. */
async function seedLegacyReservation(database: Pool, workspaceId: string, assetId: string, actualBytes: number) {
  await database.query(`INSERT INTO storage_quota_reservations
    (workspace_id,reservation_key,asset_id,reserved_bytes,actual_bytes,status,created_at,updated_at)
    VALUES ($1,$2,$3,0,$4,'settled',now(),now())`, [workspaceId, `asset:${assetId}`, assetId, actualBytes])
}

async function seedPerObjectReservation(database: Pool, workspaceId: string, assetId: string, fileName: string, actualBytes: number) {
  await database.query(`INSERT INTO storage_quota_reservations
    (workspace_id,reservation_key,asset_id,reserved_bytes,actual_bytes,status,created_at,updated_at)
    VALUES ($1,$2,$3,0,$4,'settled',now(),now())`, [workspaceId, `asset:${assetId}/${fileName}`, assetId, actualBytes])
}

async function seedWorkspace(database: Pool, workspaceId: string, limitBytes: number, usedBytes: number) {
  await database.query(`INSERT INTO workspaces (id,status) VALUES ($1,'active')`, [workspaceId])
  await database.query(`INSERT INTO workspace_storage_quotas (workspace_id,limit_bytes,used_bytes,reserved_bytes) VALUES ($1,$2,$3,0)`, [workspaceId, limitBytes, usedBytes])
}

/** The durable asset projection migration 231 reads the object name from. */
async function seedAssetObjectName(database: Pool, workspaceId: string, assetId: string, storageKey: string) {
  await database.query(`INSERT INTO business_entity_snapshots (workspace_id,entity_type,entity_id,entity_version,payload)
    VALUES ($1,'asset',$2,1,$3::jsonb)`, [workspaceId, assetId, JSON.stringify({ id: assetId, workspaceId, storageKey })])
}

/** The append-only scan evidence that proves how many objects an asset has had. */
async function seedScanReceipt(database: Pool, workspaceId: string, assetId: string, objectKey: string) {
  const receipt = {
    schema_version: 'asset-scan-receipt/1.0',
    receipt_id: `receipt_231_${assetId}`,
    subject: { workspace_id: workspaceId, asset_id: assetId, asset_source_revision: 1, object_key: objectKey, sha256: 'a'.repeat(64), mime_type: 'image/png' },
    scan: { verdict: 'clean' },
  }
  await database.query(`INSERT INTO asset_scan_receipts
    (receipt_id,workspace_id,asset_id,asset_source_revision,receipt_digest,signature,verdict,object_key,object_sha256,canonical_payload,receipt)
    VALUES ($1,$2,$3,1,$4,'signature-231','clean',$5,$6,$7,$8::jsonb)`,
    [receipt.receipt_id, workspaceId, assetId, 'b'.repeat(64), objectKey, 'a'.repeat(64), JSON.stringify(receipt), JSON.stringify(receipt)])
}

const reservationRows = async (database: Pool, workspaceId: string) => (await database.query<{ reservation_key: string; status: string; actual_bytes: string | null }>(
  `SELECT reservation_key,status,actual_bytes FROM storage_quota_reservations WHERE workspace_id=$1 ORDER BY reservation_key`, [workspaceId],
)).rows.map(row => ({ key: row.reservation_key, status: row.status, actualBytes: row.actual_bytes === null ? null : Number(row.actual_bytes) }))

const quotaTotals = async (database: Pool, workspaceId: string) => {
  const row = (await database.query<{ used_bytes: string; reserved_bytes: string }>(
    `SELECT used_bytes,reserved_bytes FROM workspace_storage_quotas WHERE workspace_id=$1`, [workspaceId],
  )).rows[0]!
  return { usedBytes: Number(row.used_bytes), reservedBytes: Number(row.reserved_bytes) }
}

const forceRowSecurity = async (database: Pool) => (await database.query<{ relname: string; relforcerowsecurity: boolean }>(
  `SELECT relname,relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`, [[...QUOTA_TABLES]],
)).rows

const runRepair = (pool: Pool, migrations: readonly Migration[]) => new MigrationRunner(pool, migrations.filter(migration => migration.version === REPAIR_VERSION)).run()

const physicalDeletion = (workspaceId: string, assetId: string, fileName: string) => ({
  reservationKey: `asset:${assetId}/${fileName}`,
  receipt: { objectKey: `quarantine/${workspaceId}/${assetId}/${fileName}`, deletedAt: new Date().toISOString(), verification: 'delete_ack' as const },
})

/**
 * The gap this closes: `storage_quota_reservations` used to be keyed
 * `asset:<assetId>` and is now keyed `asset:<assetId>/<canonical file name>`.
 * `reservation_key` is half of the primary key, so every row settled before the
 * key changed was unreachable by both runtime paths: `reserve` inserted a
 * second settled row for the same physical object, and
 * `releaseAfterPhysicalDeletion` returned without lowering `used_bytes`. These
 * cases run the real chain on PostgreSQL and assert the repaired end state, not
 * an in-memory stand-in.
 */
describe('migration 231 storage quota per-object reservation keys', () => {
  postgresIt('rewrites the legacy key so the object is neither charged twice nor left unreclaimable', async () => {
    await withUpgradeFixture(async ({ database, migrations, workspaceId, appPool }) => {
      const assetId = 'asset_legacy'
      await seedWorkspace(database, workspaceId, 1_000, 100)
      await seedLegacyReservation(database, workspaceId, assetId, 100)
      await seedAssetObjectName(database, workspaceId, assetId, `quarantine/${workspaceId}/${assetId}/photo.png`)

      expect(await runRepair(database, migrations)).toEqual([REPAIR_VERSION])
      expect(await reservationRows(database, workspaceId)).toEqual([{ key: `asset:${assetId}/photo.png`, status: 'settled', actualBytes: 100 }])
      expect(await quotaTotals(database, workspaceId)).toEqual({ usedBytes: 100, reservedBytes: 0 })

      // Re-running is a no-op: the rewritten row no longer carries the legacy key.
      expect(await runRepair(database, migrations)).toEqual([])
      expect(await reservationRows(database, workspaceId)).toEqual([{ key: `asset:${assetId}/photo.png`, status: 'settled', actualBytes: 100 }])
      expect(await quotaTotals(database, workspaceId)).toEqual({ usedBytes: 100, reservedBytes: 0 })

      const app = appPool()
      const quota = new PostgresStorageQuotaRepository(app)
      try {
        // Re-uploading the same bytes under the same file name deduplicates to
        // the same object; it must reuse the reservation instead of charging a
        // second time for one object.
        const reserved = await quota.reserve({ workspaceId, reservationKey: `asset:${assetId}/photo.png`, assetId, bytes: 100, limitBytes: 1_000 })
        expect(reserved.reused).toBe(true)
        expect(await quotaTotals(database, workspaceId)).toEqual({ usedBytes: 100, reservedBytes: 0 })

        await expect(quota.releaseAfterPhysicalDeletion({ workspaceId, ...physicalDeletion(workspaceId, assetId, 'photo.png') }))
          .resolves.toMatchObject({ reservationKey: `asset:${assetId}/photo.png`, status: 'released', reservedBytes: 0 })
        expect(await reservationRows(database, workspaceId)).toEqual([{ key: `asset:${assetId}/photo.png`, status: 'released', actualBytes: null }])
        expect(await quotaTotals(database, workspaceId)).toEqual({ usedBytes: 0, reservedBytes: 0 })
      } finally {
        await app.end()
      }
    })
  }, 240_000)

  postgresIt('reclaims legacy rows the rewrite cannot name and prefers them over a sibling object reservation', async () => {
    await withUpgradeFixture(async ({ database, migrations, workspaceId, appPool }) => {
      await seedWorkspace(database, workspaceId, 1_000, 250)
      // Nameable: the asset projection still points at the object.
      await seedLegacyReservation(database, workspaceId, 'asset_named', 100)
      await seedAssetObjectName(database, workspaceId, 'asset_named', `clean/${workspaceId}/asset_named/photo.png`)
      // Unnameable: the asset has no snapshot and no receipt left.
      await seedLegacyReservation(database, workspaceId, 'asset_orphan', 50)
      // Unnameable legacy row next to a reservation for a different object of
      // the same asset: the bare legacy key must win the fallback, because that
      // row paid for the object being deleted.
      await seedLegacyReservation(database, workspaceId, 'asset_sibling', 30)
      await seedPerObjectReservation(database, workspaceId, 'asset_sibling', 'other.png', 70)

      expect(await runRepair(database, migrations)).toEqual([REPAIR_VERSION])
      expect(await reservationRows(database, workspaceId)).toEqual([
        { key: 'asset:asset_named/photo.png', status: 'settled', actualBytes: 100 },
        { key: 'asset:asset_orphan', status: 'settled', actualBytes: 50 },
        { key: 'asset:asset_sibling', status: 'settled', actualBytes: 30 },
        { key: 'asset:asset_sibling/other.png', status: 'settled', actualBytes: 70 },
      ])

      const app = appPool()
      const quota = new PostgresStorageQuotaRepository(app)
      try {
        await expect(quota.releaseAfterPhysicalDeletion({ workspaceId, ...physicalDeletion(workspaceId, 'asset_orphan', 'ghost.png') }))
          .resolves.toMatchObject({ reservationKey: 'asset:asset_orphan', status: 'released' })
        expect(await quotaTotals(database, workspaceId)).toEqual({ usedBytes: 200, reservedBytes: 0 })

        await expect(quota.releaseAfterPhysicalDeletion({ workspaceId, ...physicalDeletion(workspaceId, 'asset_sibling', 'ghost.png') }))
          .resolves.toMatchObject({ reservationKey: 'asset:asset_sibling', status: 'released' })
        expect(await quotaTotals(database, workspaceId)).toEqual({ usedBytes: 170, reservedBytes: 0 })

        await expect(quota.releaseAfterPhysicalDeletion({ workspaceId, ...physicalDeletion(workspaceId, 'asset_named', 'photo.png') }))
          .resolves.toMatchObject({ reservationKey: 'asset:asset_named/photo.png', status: 'released' })
        expect(await quotaTotals(database, workspaceId)).toEqual({ usedBytes: 70, reservedBytes: 0 })
      } finally {
        await app.end()
      }
      // The sibling object is still on disk, so its reservation must not have
      // been the one released.
      expect(await reservationRows(database, workspaceId)).toEqual([
        { key: 'asset:asset_named/photo.png', status: 'released', actualBytes: null },
        { key: 'asset:asset_orphan', status: 'released', actualBytes: null },
        { key: 'asset:asset_sibling', status: 'released', actualBytes: null },
        { key: 'asset:asset_sibling/other.png', status: 'settled', actualBytes: 70 },
      ])
    })
  }, 240_000)

  postgresIt('collapses a duplicate charge for the same object under the deployed schema-owner credential', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_231_${randomUUID().replaceAll('-', '')}`
    const ownerRole = `quota_owner_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let owner: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const database = new Pool({ connectionString: connection(base, databaseName) })
      try {
        const migrations = await loadMigrations()
        await new MigrationRunner(database, migrations.filter(migration => migration.version <= LEGACY_KEY_VERSION)).run()
        const workspaceId = `ws_quota_231_${randomUUID().replaceAll('-', '')}`
        const assetId = 'asset_dual'
        const objectKey = `quarantine/${workspaceId}/${assetId}/photo.png`
        await seedWorkspace(database, workspaceId, 1_000, 200)
        await seedLegacyReservation(database, workspaceId, assetId, 100)
        await seedPerObjectReservation(database, workspaceId, assetId, 'photo.png', 100)
        await seedAssetObjectName(database, workspaceId, assetId, objectKey)
        // Exactly one object file name in the asset's whole scan history, so the
        // two settled rows provably describe one physical object.
        await seedScanReceipt(database, workspaceId, assetId, objectKey)

        // The deployed migration credential is the schema owner, and these
        // tables carry FORCE ROW LEVEL SECURITY, which applies the policy to the
        // owner. Running as a non-superuser owner is the only way to prove the
        // backfill is not silently reading zero rows in every workspace.
        await admin.query(`CREATE ROLE "${ownerRole}" LOGIN PASSWORD 'quota_owner_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
        await admin.query(`ALTER DATABASE "${databaseName}" OWNER TO "${ownerRole}"`)
        // Ownership is per database: these must be the scratch database's
        // relations, not the ones in the database the admin URL points at.
        for (const table of [...QUOTA_TABLES, 'schema_migrations']) await database.query(`ALTER TABLE ${table} OWNER TO "${ownerRole}"`)

        owner = new Pool({ connectionString: connection(base, databaseName, ownerRole, 'quota_owner_local_only') })
        expect(await runRepair(owner, migrations)).toEqual([REPAIR_VERSION])
        // The duplicate legacy row is repaid and released; the per-object row
        // the runtime can still reach is the one that survives as settled.
        expect(await reservationRows(database, workspaceId)).toEqual([
          { key: `asset:${assetId}`, status: 'released', actualBytes: null },
          { key: `asset:${assetId}/photo.png`, status: 'settled', actualBytes: 100 },
        ])
        expect(await quotaTotals(database, workspaceId)).toEqual({ usedBytes: 100, reservedBytes: 0 })
        // The suspension of FORCE is reverted with the migration, not left behind.
        expect(await forceRowSecurity(database)).toEqual(QUOTA_TABLES.map(relname => ({ relname, relforcerowsecurity: true })))
      } finally {
        await database.end()
      }
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await owner?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [
        () => admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`),
        () => admin.end(),
      ])
    }
  }, 240_000)
})
