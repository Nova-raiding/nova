import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { reservationKeyFor, reservationKeyForObjectKey } from '../../storage/src/reservation-key.js'
import { loadMigrations, MigrationRunner, type Migration } from './migration.js'
import { PostgresStorageQuotaRepository } from './storage-quota-repository.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

/** The version the per-object reservation key landed in. */
const LEGACY_KEY_VERSION = 230
const REPAIR_VERSION = 232

const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

interface ScratchFixture {
  admin: Pool
  database: Pool
  databaseName: string
  migrations: readonly Migration[]
  appPool: () => Pool
}

/**
 * A scratch database on the real migration chain. `migrateTo` exists so a case
 * can install pre-per-object ledger rows before the migrations that repair them
 * run, i.e. the upgrade path under test is the one a deployed database takes.
 */
async function withScratchFixture(migrateTo: number | undefined, body: (fixture: ScratchFixture) => Promise<void>): Promise<void> {
  const base = new URL(databaseUrlValue!)
  const databaseName = `release_232_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: base.toString() })
  let database: Pool | undefined
  let primaryFailure: unknown
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    database = new Pool({ connectionString: connection(base, databaseName) })
    const migrations = await loadMigrations()
    await new MigrationRunner(database, migrateTo ? migrations.filter(migration => migration.version <= migrateTo) : migrations).run()
    await body({
      admin,
      database,
      databaseName,
      migrations,
      appPool: () => new Pool({ connectionString: connection(base, databaseName, process.env.STORAGE_QUOTA_APP_DATABASE_USER ?? 'merchant_app', process.env.STORAGE_QUOTA_APP_DATABASE_PASSWORD ?? 'merchant_app_local_only'), max: 2 }),
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

const seedWorkspace = async (database: Pool, workspaceId: string, limitBytes: number, usedBytes: number) => {
  await database.query(`INSERT INTO workspaces (id,status) VALUES ($1,'active')`, [workspaceId])
  await database.query(`INSERT INTO workspace_storage_quotas (workspace_id,limit_bytes,used_bytes,reserved_bytes) VALUES ($1,$2,$3,0)`, [workspaceId, limitBytes, usedBytes])
}

/** A settled reservation in the shape the runtime writes (or the legacy bare key). */
async function seedReservation(database: Pool, workspaceId: string, assetId: string, reservationKey: string, actualBytes: number | null, status = 'settled') {
  await database.query(`INSERT INTO storage_quota_reservations
    (workspace_id,reservation_key,asset_id,reserved_bytes,actual_bytes,status,created_at,updated_at)
    VALUES ($1,$2,$3,0,$4,$5,now(),now())`, [workspaceId, reservationKey, assetId, actualBytes, status])
}

/** The durable upload event that names the object an asset was stored under. */
async function seedUploadEvent(database: Pool, workspaceId: string, assetId: string, sequence: number, storageKey: string) {
  await database.query(`INSERT INTO outbox_events (id,workspace_id,aggregate_id,event_type,sequence,payload)
    VALUES ($1,$2,$3,'asset.uploaded',$4,$5::jsonb)`,
  [`event_232_${assetId}_${sequence}`, workspaceId, assetId, sequence, JSON.stringify({ asset_id: assetId, storage_key: storageKey })])
}

const reservationRows = async (database: Pool, workspaceId: string) => (await database.query<{ reservation_key: string; status: string }>(
  `SELECT reservation_key,status FROM storage_quota_reservations WHERE workspace_id=$1 ORDER BY reservation_key`, [workspaceId],
)).rows.map(row => `${row.reservation_key}:${row.status}`)

const usedBytes = async (database: Pool, workspaceId: string) => Number((await database.query<{ used_bytes: string }>(
  `SELECT used_bytes FROM workspace_storage_quotas WHERE workspace_id=$1`, [workspaceId])).rows[0]!.used_bytes)

const physicalDeletion = (workspaceId: string, assetId: string, fileName: string) => ({
  reservationKey: reservationKeyFor({ assetId, fileName }),
  receipt: { objectKey: `quarantine/${workspaceId}/${assetId}/${fileName}`, deletedAt: new Date().toISOString(), verification: 'delete_ack' as const },
})

const runMigrations = (pool: Pool, migrations: readonly Migration[], versions: readonly number[]) =>
  new MigrationRunner(pool, migrations.filter(migration => versions.includes(migration.version))).run()

/** The tables migration 232 has to read or write around FORCE ROW LEVEL SECURITY. */
const QUOTA_TABLES = ['asset_scan_receipts', 'business_entity_snapshots', 'object_storage_orphans', 'outbox_events', 'storage_quota_reservations', 'workspace_storage_quotas'] as const

const forceRowSecurity = async (database: Pool) => (await database.query<{ relname: string; relforcerowsecurity: boolean }>(
  `SELECT relname,relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`, [[...QUOTA_TABLES]],
)).rows

/**
 * The invariant these cases pin: a settled reservation row can only be released
 * by the deletion of the object it describes, for the bytes that object really
 * occupies - and a row that cannot name its object is repaired, never guessed at.
 *
 * Every case drives the real `PostgresStorageQuotaRepository` as `merchant_app`
 * against a real PostgreSQL chain, so the SQL under test is the SQL that ships.
 */
describe('storage quota reservation identity', () => {
  postgresIt('does not release a sibling object reservation for an object it does not describe', async () => {
    await withScratchFixture(undefined, async ({ database, appPool }) => {
      const workspaceId = `ws_232_sibling_${randomUUID().replaceAll('-', '')}`
      await seedWorkspace(database, workspaceId, 1_000, 100)
      // The legacy row for this asset was already repaid, and `keep.txt` (100
      // bytes) is still stored under the same asset id.
      await seedReservation(database, workspaceId, 'asset_sibling', 'asset:asset_sibling', null, 'released')
      await seedReservation(database, workspaceId, 'asset_sibling', 'asset:asset_sibling/keep.txt', 100)

      const app = appPool()
      const quota = new PostgresStorageQuotaRepository(app)
      try {
        // A deletion for an object of the same asset that has no reservation of
        // its own. It must not reach the live sibling's row.
        const released = await quota.releaseAfterPhysicalDeletion({ workspaceId, ...physicalDeletion(workspaceId, 'asset_sibling', 'ghost.txt') })
        expect(released).toBeUndefined()
        expect(await reservationRows(database, workspaceId)).toEqual(['asset:asset_sibling:released', 'asset:asset_sibling/keep.txt:settled'])
        expect(await usedBytes(database, workspaceId)).toBe(100)

        // The object the row does describe: deleting it repays exactly its bytes.
        await expect(quota.releaseAfterPhysicalDeletion({ workspaceId, ...physicalDeletion(workspaceId, 'asset_sibling', 'keep.txt') }))
          .resolves.toMatchObject({ reservationKey: 'asset:asset_sibling/keep.txt', status: 'released' })
        expect(await usedBytes(database, workspaceId)).toBe(0)
      } finally {
        await app.end()
      }
    })
  }, 240_000)

  postgresIt('binds the ledger row to the object the storage layer actually wrote', async () => {
    await withScratchFixture(undefined, async ({ database, appPool }) => {
      const workspaceId = `ws_232_canonical_${randomUUID().replaceAll('-', '')}`
      const assetId = 'asset_canonical'
      await seedWorkspace(database, workspaceId, 1_000, 0)
      const app = appPool()
      const quota = new PostgresStorageQuotaRepository(app)
      try {
        // An upload whose file name is not yet canonical. The object store
        // canonicalizes it, so the ledger key has to name the stored object.
        const reservationKey = reservationKeyFor({ assetId, fileName: 'Quarterly Report 2026.PNG' })
        expect(reservationKey).toBe(`asset:${assetId}/quarterly_report_2026.png`)
        await quota.reserve({ workspaceId, reservationKey, assetId, bytes: 64, limitBytes: 1_000 })
        await quota.settle({ workspaceId, reservationKey, actualBytes: 64 })
        expect(await usedBytes(database, workspaceId)).toBe(64)

        const objectKey = `quarantine/${workspaceId}/${assetId}/quarterly_report_2026.png`
        const releaseKey = reservationKeyForObjectKey(objectKey, workspaceId)
        expect(releaseKey).toBe(reservationKey)
        await quota.releaseAfterPhysicalDeletion({ workspaceId, reservationKey: releaseKey!, receipt: { objectKey, deletedAt: new Date().toISOString(), verification: 'delete_ack' } })
        expect(await usedBytes(database, workspaceId)).toBe(0)
        expect(await reservationRows(database, workspaceId)).toEqual([`asset:${assetId}/quarterly_report_2026.png:released`])
      } finally {
        await app.end()
      }
    })
  }, 240_000)

  postgresIt('releases the object whose stored name ends in the cloud metadata suffix', async () => {
    await withScratchFixture(undefined, async ({ database, appPool }) => {
      const workspaceId = `ws_232_meta_${randomUUID().replaceAll('-', '')}`
      const assetId = 'asset_meta'
      await seedWorkspace(database, workspaceId, 1_000, 0)
      const app = appPool()
      const quota = new PostgresStorageQuotaRepository(app)
      try {
        // `config.merchant-meta.json` is a legal object body name (the storage
        // layer reserves only the *metadata* key, `<body>.merchant-meta.json`),
        // so a body uploaded under it still owns a ledger row.
        const reservationKey = reservationKeyFor({ assetId, fileName: 'config.merchant-meta.json' })
        await quota.reserve({ workspaceId, reservationKey, assetId, bytes: 42, limitBytes: 1_000 })
        await quota.settle({ workspaceId, reservationKey, actualBytes: 42 })

        const objectKey = `quarantine/${workspaceId}/${assetId}/config.merchant-meta.json`
        const releaseKey = reservationKeyForObjectKey(objectKey, workspaceId)
        expect(releaseKey).toBe(reservationKey)
        await quota.releaseAfterPhysicalDeletion({ workspaceId, reservationKey: releaseKey!, receipt: { objectKey, deletedAt: new Date().toISOString(), verification: 'delete_ack' } })
        expect(await usedBytes(database, workspaceId)).toBe(0)
      } finally {
        await app.end()
      }
    })
  }, 240_000)

  postgresIt('names a legacy row from the durable object references migration 231 could not read, and never guesses between two objects', async () => {
    await withScratchFixture(LEGACY_KEY_VERSION, async ({ database, appPool, migrations }) => {
      const named = `ws_232_named_${randomUUID().replaceAll('-', '')}`
      const ambiguous = `ws_232_ambiguous_${randomUUID().replaceAll('-', '')}`
      const archived = `ws_232_archived_${randomUUID().replaceAll('-', '')}`
      const gone = `ws_232_gone_${randomUUID().replaceAll('-', '')}`
      await seedWorkspace(database, named, 1_000, 100)
      await seedWorkspace(database, ambiguous, 1_000, 100)
      await seedWorkspace(database, archived, 1_000, 100)
      await seedWorkspace(database, gone, 1_000, 100)
      // One legacy row per asset, none of which migration 231 can name: the
      // asset projection and the scan receipts are all gone.
      await seedReservation(database, named, 'asset_named', 'asset:asset_named', 100)
      await seedReservation(database, ambiguous, 'asset_ambiguous', 'asset:asset_ambiguous', 100)
      await seedReservation(database, archived, 'asset_archived', 'asset:asset_archived', 100)
      await seedReservation(database, gone, 'asset_gone', 'asset:asset_gone', 100)
      // The durable upload event survives, and it names the object.
      await seedUploadEvent(database, named, 'asset_named', 1, `quarantine/${named}/asset_named/photo.png`)
      // Two objects for one asset: attributing the row to either of them would
      // be a guess, and a guess is how a live object loses its reservation.
      await seedUploadEvent(database, ambiguous, 'asset_ambiguous', 1, `quarantine/${ambiguous}/asset_ambiguous/first.png`)
      await seedUploadEvent(database, ambiguous, 'asset_ambiguous', 2, `clean/${ambiguous}/asset_ambiguous/second.png`)
      // The generation job that archived this asset is its only durable record
      // left. `persistSnapshotAndEvent` stores `job` verbatim
      // (apps/api/src/server.ts), so the output entries carry
      // `VisualGenerationOutput`'s camel-case `assetId`/`storageKey` - the
      // snake-case spelling belongs to the outbox event payload below, not to
      // the snapshot.
      await database.query(`INSERT INTO business_entity_snapshots
        (workspace_id,entity_type,entity_id,entity_version,payload)
        VALUES ($1,'image_generation_job','job_archived',3,$2::jsonb)`, [archived, JSON.stringify({
        id: 'job_archived', workspaceId: archived, productId: 'product_1', state: 'succeeded',
        artifactRole: 'candidate', archiveState: 'archived', revision: 3,
        outputs: [{
          visualRef: 'dvis_archived', assetId: 'asset_archived', ordinal: 1,
          storageKey: `clean/${archived}/asset_archived/generated.png`,
          mimeType: 'image/png', sizeBytes: 100, sha256: 'a'.repeat(64),
          createdAt: '2026-01-01T00:00:00.000Z', reviewStatus: 'unreviewed',
        }],
      })])
      // The only object key any durable record still names for this asset is
      // one whose object is already deleted: `markCleaned` in
      // object-orphan-repository.ts only runs after `deleteObject` succeeded.
      // The asset's live object (`live.png`) has no durable record anywhere -
      // which is why 231 could not name the row.
      await database.query(`INSERT INTO object_storage_orphans
        (id,workspace_id,object_key,reason,state,attempts)
        VALUES ($1,$2,$3,'promotion_cleanup','cleaned',1)`,
      ['orphan_gone', gone, `quarantine/${gone}/asset_gone/deleted.png`])

      expect(await runMigrations(database, migrations, [LEGACY_KEY_VERSION + 1, REPAIR_VERSION])).toEqual([LEGACY_KEY_VERSION + 1, REPAIR_VERSION])
      expect(await reservationRows(database, named)).toEqual(['asset:asset_named/photo.png:settled'])
      expect(await reservationRows(database, ambiguous)).toEqual(['asset:asset_ambiguous:settled'])
      expect(await reservationRows(database, archived)).toEqual(['asset:asset_archived/generated.png:settled'])
      // Left unnamed on purpose: binding it to `deleted.png` would name a key no
      // future deletion can repay, while the bare key stays reachable by the
      // asset-scoped release fallback.
      expect(await reservationRows(database, gone)).toEqual(['asset:asset_gone:settled'])
      // Idempotent: a second run has nothing left to match.
      expect(await runMigrations(database, migrations, [REPAIR_VERSION])).toEqual([])
      expect(await reservationRows(database, named)).toEqual(['asset:asset_named/photo.png:settled'])

      const app = appPool()
      const quota = new PostgresStorageQuotaRepository(app)
      try {
        // The renamed row is now reachable by the key the runtime writes, so a
        // re-upload reuses it instead of charging the same object twice.
        const reused = await quota.reserve({ workspaceId: named, reservationKey: 'asset:asset_named/photo.png', assetId: 'asset_named', bytes: 100, limitBytes: 1_000 })
        expect(reused.reused).toBe(true)
        expect(await usedBytes(database, named)).toBe(100)

        // ...and deleting that object repays exactly the bytes it occupies.
        await quota.releaseAfterPhysicalDeletion({ workspaceId: named, ...physicalDeletion(named, 'asset_named', 'photo.png') })
        expect(await usedBytes(database, named)).toBe(0)
        expect(await reservationRows(database, ambiguous)).toEqual(['asset:asset_ambiguous:settled'])

        // The row named from the generation snapshot is reachable by the key
        // the deleting side derives, so its bytes come back with the object.
        await quota.releaseAfterPhysicalDeletion({ workspaceId: archived, ...physicalDeletion(archived, 'asset_archived', 'generated.png') })
        expect(await usedBytes(database, archived)).toBe(0)
        expect(await reservationRows(database, archived)).toEqual(['asset:asset_archived/generated.png:released'])

        // The row left unnamed stays reclaimable by the asset-scoped fallback:
        // the asset's live object is deleted and the ledger stops charging for
        // bytes it no longer stores.
        await expect(quota.releaseAfterPhysicalDeletion({ workspaceId: gone, ...physicalDeletion(gone, 'asset_gone', 'live.png') }))
          .resolves.toMatchObject({ reservationKey: 'asset:asset_gone', status: 'released' })
        expect(await usedBytes(database, gone)).toBe(0)
        expect(await reservationRows(database, gone)).toEqual(['asset:asset_gone:released'])
      } finally {
        await app.end()
      }
    })
  }, 240_000)

  postgresIt('names the legacy row under the deployed schema-owner credential, where FORCE RLS applies to the reader', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_232_${randomUUID().replaceAll('-', '')}`
    const ownerRole = `quota_owner_232_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let owner: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const database = new Pool({ connectionString: connection(base, databaseName) })
      try {
        const migrations = await loadMigrations()
        await new MigrationRunner(database, migrations.filter(migration => migration.version <= LEGACY_KEY_VERSION)).run()
        const workspaceId = `ws_232_owner_${randomUUID().replaceAll('-', '')}`
        await seedWorkspace(database, workspaceId, 1_000, 100)
        await seedReservation(database, workspaceId, 'asset_owner', 'asset:asset_owner', 100)
        await seedUploadEvent(database, workspaceId, 'asset_owner', 1, `quarantine/${workspaceId}/asset_owner/photo.png`)

        // The deployed migration credential is the schema owner, and every table
        // this migration reads or writes carries FORCE ROW LEVEL SECURITY, which
        // applies the policy to the owner. Running as a non-superuser owner is
        // the only way to prove the backfill is not silently reading zero rows in
        // every workspace and doing nothing.
        await admin.query(`CREATE ROLE "${ownerRole}" LOGIN PASSWORD 'quota_owner_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
        await admin.query(`ALTER DATABASE "${databaseName}" OWNER TO "${ownerRole}"`)
        for (const table of ['storage_quota_reservations', 'workspace_storage_quotas', 'business_entity_snapshots', 'asset_scan_receipts', 'outbox_events', 'object_storage_orphans', 'schema_migrations']) {
          await database.query(`ALTER TABLE ${table} OWNER TO "${ownerRole}"`)
        }

        owner = new Pool({ connectionString: connection(base, databaseName, ownerRole, 'quota_owner_local_only') })
        expect(await runMigrations(owner, migrations, [REPAIR_VERSION])).toEqual([REPAIR_VERSION])
        expect(await reservationRows(database, workspaceId)).toEqual(['asset:asset_owner/photo.png:settled'])
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
