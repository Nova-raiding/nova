import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner, verifyAppliedMigrations } from '../packages/persistence/src/migration.js'
import { PostgresCreativePointRepository } from '../packages/persistence/src/creative-point-repository.js'
import { PostgresAssetLifecycleRepository } from '../packages/persistence/src/asset-lifecycle-repository.js'
import { LocalObjectStorage } from '../packages/storage/src/object-storage.js'
import { createWorkerRequestProof } from '../packages/security/src/worker-request-proof.js'
import { createIsolatedOpsFixture } from './isolated-ops-fixture.js'

const token = 'isolated-254-255-bridge-token'
const automationToken = 'isolated-automation-token'
const automationSecret = 'isolated-automation-signing-secret'
const workspaceId = 'ws_bridge_254_255'
const apiDiagnostics = new WeakMap<ChildProcess, () => string>()

async function freeLoopbackPort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((done, reject) => listener.once('error', reject).listen(0, '127.0.0.1', done))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('isolated API port unavailable')
  await new Promise<void>(done => listener.close(() => done()))
  return address.port
}

async function startApi(input: { databaseUrl: string; opsDatabaseUrl: string; redisUrl: string; port: number; bridgeMode?: 'prefix_254_or_255' | 'prefix_255_or_256' | null; testCommercialFixture?: boolean; assetStorageRoot?: string }): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
    NODE_ENV: 'development', AUTH_ENFORCEMENT: 'strict', PERSISTENCE_MODE: 'postgres',
    DATABASE_URL: input.databaseUrl, OPS_DATABASE_URL: input.opsDatabaseUrl, REDIS_URL: input.redisUrl,
    RUN_MIGRATIONS_ON_STARTUP: 'false', ...(input.bridgeMode === null ? {} : { BRIDGE_SCHEMA_COMPATIBILITY_MODE: input.bridgeMode ?? 'prefix_254_or_255' }),
    SESSION_ID_HASH_SECRET: 'isolated-254-255-api-bridge-secret',
    API_BIND_HOST: '127.0.0.1', PORT: String(input.port),
    CONNECTOR_FIXTURE_MODE: 'false',
    API_AUTH_TOKENS: JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: 'bridge-actor', roles: ['merchant_admin'], workbenches: ['workspace'] } }),
    WORKER_API_CREDENTIALS: JSON.stringify(Object.fromEntries(['sync', 'generation', 'publish', 'reconcile', 'automation', 'scan'].map(role => [role, { token: `isolated-${role}-token`, signing_secret: `isolated-${role}-signing-secret` }]))),
    ...(input.assetStorageRoot ? { ASSET_STORAGE_ROOT: input.assetStorageRoot } : {}),
  }
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], {
    cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Drain both streams so the child never blocks on a full pipe. Keep only
  // bounded diagnostics and never print generated database or Redis URLs.
  let diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
    diagnostics = `${diagnostics}${String(chunk)}`.slice(-4000)
  })
  apiDiagnostics.set(child, () => diagnostics.replaceAll(input.databaseUrl, '[database]').replaceAll(input.opsDatabaseUrl, '[ops-database]').replaceAll(input.redisUrl, '[redis]'))
  const url = `http://127.0.0.1:${input.port}/readyz`
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated API exited before readiness: ${diagnostics.replaceAll(input.databaseUrl, '[database]').replaceAll(input.opsDatabaseUrl, '[ops-database]').replaceAll(input.redisUrl, '[redis]')}`)
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return child } catch { /* starting */ }
    await new Promise(done => setTimeout(done, 250))
  }
  child.kill('SIGTERM')
  throw new Error(`isolated API readiness timed out: ${diagnostics.replaceAll(input.databaseUrl, '[database]').replaceAll(input.opsDatabaseUrl, '[ops-database]').replaceAll(input.redisUrl, '[redis]')}`)
}

async function stopApi(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(done => child.once('exit', () => done())),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('isolated API did not drain after SIGTERM')), 10_000)),
  ])
}

describe('254/255 API bridge on an owned PostgreSQL 17 fixture', () => {
  it('keeps the new route closed at 254 and serves it after a checked 255 migration', async () => {
    const evidenceDir = resolve('artifacts/bridge-254-255-isolation', randomUUID())
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    const fixture = await createIsolatedOpsFixture({ evidenceDir })
    const databaseUrl = fixture.acceptanceDatabaseUrls?.legacyBackfill
    if (!databaseUrl) throw new Error('isolated empty PostgreSQL database unavailable')
    const admin = new Pool({ connectionString: databaseUrl })
    const databaseName = new URL(databaseUrl).pathname.slice(1)
    const appUrl = new URL(fixture.databaseUrl)
    appUrl.pathname = `/${databaseName}`
    const opsUrl = new URL(fixture.opsDatabaseUrl)
    opsUrl.pathname = `/${databaseName}`
    const app = new Pool({ connectionString: appUrl.toString() })
      const storageRoot = await mkdtemp(join(tmpdir(), 'store-nova-asset-purge-'))
    let child: ChildProcess | undefined
    try {
      const migrations = await loadMigrations()
      expect(migrations.at(-1)?.version).toBe(256)
      const roleSql = await readFile(new URL('../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      const databaseGrant = /ON DATABASE merchant\b/gu
      const grantCount = [...roleSql.matchAll(databaseGrant)].length
      expect(grantCount).toBe(3)
      const isolatedRoleSql = roleSql.replace(databaseGrant, `ON DATABASE "${databaseName}"`)
      await admin.query(isolatedRoleSql)
      await new MigrationRunner(admin, migrations.slice(0, 254)).run()
      await admin.query(isolatedRoleSql)
      await admin.query('INSERT INTO workspaces(id,status) VALUES ($1,$2)', [workspaceId, 'active'])
      await admin.query("INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by) VALUES ($1,$2,'bridge-actor','Bridge Actor','merchant_admin','active','isolated-bridge-fixture')", [randomUUID(), workspaceId])
      // The commercial HTTP gate requires a known balance before route
      // dispatch. Seed a durable fixture grant so bridge assertions reach the
      // lifecycle guard instead of failing early with unknown points.
      await new PostgresCreativePointRepository(admin).grant({
        workspaceId,
        idempotencyKey: 'isolated-bridge-fixture-grant',
        sourceType: 'test_fixture',
        sourceId: 'isolated-bridge-254-256',
        points: 100,
        metadata: { test_only: true, non_production: true },
      })
      // Asset lifecycle writes are classified as POINT_REQUIRED_NO_CHARGE,
      // which still requires one authoritative continuous entitlement. Give
      // this disposable workspace a synthetic, executable basic-plan period
      // so the bridge assertion reaches lifecycle schema availability rather
      // than being stopped by the normal commercial access gate.
      const commercialFixtureId = randomUUID()
      const orderId = `bridge-order-${commercialFixtureId}`
      const orderSnapshotId = `bridge-order-snapshot-${commercialFixtureId}`
      const periodId = `bridge-period-${commercialFixtureId}`
      const periodStart = new Date(Date.now() - 60_000).toISOString()
      const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      const port254 = await freeLoopbackPort()
      // The API uses the same least-privilege merchant_app and merchant_ops
      // roles as production. The admin connection only creates the isolated
      // schema, seeds the fixture, and advances the migration prefix.
      child = await startApi({ databaseUrl: appUrl.toString(), opsDatabaseUrl: opsUrl.toString(), redisUrl: fixture.redisUrl, port: port254, assetStorageRoot: storageRoot })
      const getBrand = (port: number) => fetch(`http://127.0.0.1:${port}/v1/brand-scopes`, {
        headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId },
      })
      const closed = await getBrand(port254)
      const closedBody = await closed.json()
      expect(closed.status, `${JSON.stringify(closedBody)} ${apiDiagnostics.get(child)?.() ?? ''}`).toBe(503)
      expect(JSON.stringify(closedBody)).toContain('BRAND_SCOPES_NOT_CONFIGURED')
      const absent = await admin.query<{ exists: string | null }>("SELECT to_regclass('merchant_brand_scoped_settings')::text AS exists")
      expect(absent.rows[0]?.exists).toBeNull()

      expect(await new MigrationRunner(admin, migrations.slice(0, 255)).run()).toEqual([255])
      await admin.query(isolatedRoleSql)
      const history = (await admin.query<{ version: number; name: string; checksum: string }>('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows
      expect(history).toHaveLength(255)
      expect(() => verifyAppliedMigrations(history, migrations.slice(0, 255))).not.toThrow()
      // A process booted against 254 must revoke readiness when the database
      // moves to 255. Its repository set was fixed at startup; only a restart
      // can enable the new route against the new schema safely.
      const staleReadiness = await fetch(`http://127.0.0.1:${port254}/readyz`)
      expect(staleReadiness.status).toBe(503)
      await stopApi(child); child = undefined
      const port255 = await freeLoopbackPort()
      child = await startApi({ databaseUrl: appUrl.toString(), opsDatabaseUrl: opsUrl.toString(), redisUrl: fixture.redisUrl, port: port255, assetStorageRoot: storageRoot })
      const opened = await getBrand(port255)
      expect(opened.status).toBe(200)
      expect(JSON.stringify(await opened.json())).toContain(workspaceId)

      await admin.query("INSERT INTO workspaces(id,status) VALUES ('ws_bridge_other','active')")
      await admin.query("INSERT INTO merchant_brand_scoped_settings(workspace_id,settings,updated_by_actor_id) VALUES ($1,'{\"schemaVersion\":1}'::jsonb,'fixture')", [workspaceId])
      const client = await app.connect()
      try {
        await client.query('BEGIN READ ONLY')
        await client.query("SELECT set_config('app.workspace_id','ws_bridge_other',true)")
        expect((await client.query('SELECT workspace_id FROM merchant_brand_scoped_settings')).rows).toEqual([])
        await client.query('COMMIT')
      } finally { await client.query('ROLLBACK'); client.release() }

      // The next reviewed bridge has its own exact-prefix contract. It starts
      // ready on 255, revokes readiness as soon as migration 256 appears, and
      // becomes ready again only after a restart that rebuilds repositories
      // for the newly observed schema. The 256-only trash-list route remains
      // unavailable for the whole compatibility deployment phase.
      await stopApi(child); child = undefined
      const portBridge255 = await freeLoopbackPort()
      child = await startApi({ databaseUrl: appUrl.toString(), opsDatabaseUrl: opsUrl.toString(), redisUrl: fixture.redisUrl, port: portBridge255, bridgeMode: 'prefix_255_or_256', assetStorageRoot: storageRoot })
      expect(await new MigrationRunner(admin, migrations).run()).toEqual([256])
      await admin.query(isolatedRoleSql)
      const stale256Readiness = await fetch(`http://127.0.0.1:${portBridge255}/readyz`)
      expect(stale256Readiness.status).toBe(503)
      await stopApi(child); child = undefined
      // Seed two durable asset snapshots and trash one through the production
      // app role. A 255/256 bridge at prefix 256 must keep that row hidden and
      // reject lifecycle writes until the normal v256 API image is active.
      const assetId = 'asset_bridge_256_active'
      const trashedAssetId = 'asset_bridge_256_trashed'
      const assetSnapshot = (id: string) => ({
        id, workspaceId, name: `${id}.txt`, mimeType: 'text/plain', sizeBytes: 32,
        sha256: 'd'.repeat(64), sourceRevision: 1,
        storageKey: `quarantine/${workspaceId}/${id}.txt`, rightsStatus: 'pending',
        scanStatus: 'quarantined', parseStatus: 'pending', contentTrust: { status: 'untrusted', reasons: ['not_scanned'] },
        references: [{ name: `${id}.txt`, mimeType: 'text/plain', firstSeenAt: new Date().toISOString() }],
        uploadedByActorIds: ['bridge-actor'], revision: 1, createdAt: new Date().toISOString(),
      })
      for (const id of [assetId, trashedAssetId]) {
        await admin.query(`INSERT INTO business_entity_snapshots(workspace_id,entity_type,entity_id,entity_version,payload)
          VALUES ($1,'asset',$2,1,$3::jsonb)`, [workspaceId, id, JSON.stringify(assetSnapshot(id))])
      }
      await new PostgresAssetLifecycleRepository(app).trash({ workspaceId, assetId: trashedAssetId, actorId: 'bridge-actor', expectedRevision: 1 })
      const port256 = await freeLoopbackPort()
      child = await startApi({ databaseUrl: appUrl.toString(), opsDatabaseUrl: opsUrl.toString(), redisUrl: fixture.redisUrl, port: port256, bridgeMode: 'prefix_255_or_256' })
      expect((await fetch(`http://127.0.0.1:${port256}/readyz`)).status).toBe(200)
      const bridgeHeaders = { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId }
      // Purge and cancel remain POINT_REQUIRED_NO_CHARGE operations. Without
      // a durable executable entitlement, their registered commercial gate
      // must deny before lifecycle schema availability is considered.
      const purgeWithoutEntitlement = await fetch(`http://127.0.0.1:${port256}/v1/assets/${encodeURIComponent(trashedAssetId)}/purge`, {
        method: 'POST', headers: { ...bridgeHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm_asset_name: `${trashedAssetId}.txt`, reason: 'commercial gate regression assertion', expected_revision: 1 }),
      })
      expect(purgeWithoutEntitlement.status).toBe(402)
      expect(JSON.stringify(await purgeWithoutEntitlement.json())).toContain('COMMERCIAL_ENTITLEMENT_REQUIRED')
      const cancelWithoutEntitlement = await fetch(`http://127.0.0.1:${port256}/v1/assets/${encodeURIComponent(trashedAssetId)}/purge/cancel`, {
        method: 'POST', headers: { ...bridgeHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ expected_revision: 1 }),
      })
      expect(cancelWithoutEntitlement.status).toBe(402)
      expect(JSON.stringify(await cancelWithoutEntitlement.json())).toContain('COMMERCIAL_ENTITLEMENT_REQUIRED')
      const lifecycleAfterCommercialDenial = await admin.query<{ purge_requested_at: string | null; revision: number }>(
        'SELECT purge_requested_at, revision FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND asset_id=$2',
        [workspaceId, trashedAssetId],
      )
      expect(lifecycleAfterCommercialDenial.rows).toEqual([{ purge_requested_at: null, revision: 1 }])
      await admin.query(`INSERT INTO commercial_orders_v2
        (id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,provider_order_id,paid_at)
        VALUES ($1,$2,'sku-monthly-basic','sku-version-monthly-basic-v2',200000,'CNY','fixture','paid',$3,$4,'bridge-actor',$5,now())`,
        [orderId, workspaceId, `bridge-entitlement:${commercialFixtureId}`, 'a'.repeat(64), `bridge-fixture-${commercialFixtureId}`])
      await admin.query(`INSERT INTO commercial_order_snapshots_v2
        (id,workspace_id,order_id,sku_id,sku_version_id,catalog_checksum,snapshot,checksum)
        VALUES ($1,$2,$3,'sku-monthly-basic','sku-version-monthly-basic-v2',$4,$5::jsonb,$6)`,
        [orderSnapshotId, workspaceId, orderId, 'b'.repeat(64), JSON.stringify({ fixture: 'bridge-254-256', simulated: true }), 'c'.repeat(64)])
      await admin.query(`INSERT INTO workspace_subscription_periods_v2
        (id,workspace_id,order_snapshot_id,period_start,period_end,status,revision)
        VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,'active',1)`,
        [periodId, workspaceId, orderSnapshotId, periodStart, periodEnd])
      await admin.query(`INSERT INTO workspace_entitlement_snapshots_v2
        (id,workspace_id,subscription_period_id,subscription_period_revision,catalog_version_id,rate_card_version_id,resolved_benefits,unresolved_blockers,executable,checksum)
        VALUES ($1,$2,$3,1,'sku-version-monthly-basic-v2',NULL,$4::jsonb,'[]'::jsonb,true,$5)`,
        [`bridge-entitlement-${commercialFixtureId}`, workspaceId, periodId, JSON.stringify([
          { code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 5 }, { code: 'monthly_creative_points', quantity: 5000 },
        ]), 'd'.repeat(64)])
      const bridgeTrash = await fetch(`http://127.0.0.1:${port256}/v1/assets/trash`, { headers: bridgeHeaders })
      const bridgeTrashBody = await bridgeTrash.json()
      expect(bridgeTrash.status, JSON.stringify(bridgeTrashBody)).toBe(503)
      expect(JSON.stringify(bridgeTrashBody)).toContain('ASSET_LIFECYCLE_UNAVAILABLE')
      const bridgeAssets = await fetch(`http://127.0.0.1:${port256}/v1/assets`, { headers: bridgeHeaders })
      const bridgeAssetsBody = JSON.stringify(await bridgeAssets.json())
      expect(bridgeAssets.status).toBe(200)
      expect(bridgeAssetsBody).toContain(assetId)
      expect(bridgeAssetsBody).not.toContain(trashedAssetId)
      const bridgeDownload = await fetch(`http://127.0.0.1:${port256}/v1/assets/${encodeURIComponent(trashedAssetId)}/download`, { headers: bridgeHeaders })
      expect(bridgeDownload.status).toBe(410)
      const bridgeTrashWrite = await fetch(`http://127.0.0.1:${port256}/v1/assets/${encodeURIComponent(assetId)}/trash`, { method: 'POST', headers: { ...bridgeHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ expected_revision: 1 }) })
      expect(bridgeTrashWrite.status).toBe(503)
      const bridgeRestoreWrite = await fetch(`http://127.0.0.1:${port256}/v1/assets/${encodeURIComponent(trashedAssetId)}/restore`, { method: 'POST', headers: { ...bridgeHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ expected_revision: 1 }) })
      expect(bridgeRestoreWrite.status).toBe(503)
      const lifecycleBeforeBlockedPurge = await admin.query<{ purge_requested_at: string | null; revision: number }>(
        'SELECT purge_requested_at, revision FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND asset_id=$2',
        [workspaceId, trashedAssetId],
      )
      expect(lifecycleBeforeBlockedPurge.rows).toEqual([{ purge_requested_at: null, revision: 1 }])
      const bridgePurgeWrite = await fetch(`http://127.0.0.1:${port256}/v1/assets/${encodeURIComponent(trashedAssetId)}/purge`, {
        method: 'POST', headers: { ...bridgeHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm_asset_name: `${trashedAssetId}.txt`, reason: 'isolated bridge fail-closed assertion', expected_revision: 1 }),
      })
      const bridgePurgeBody = await bridgePurgeWrite.json()
      expect(bridgePurgeWrite.status, JSON.stringify(bridgePurgeBody)).toBe(503)
      expect(JSON.stringify(bridgePurgeBody)).toContain('ASSET_LIFECYCLE_UNAVAILABLE')
      const bridgePurgeCancel = await fetch(`http://127.0.0.1:${port256}/v1/assets/${encodeURIComponent(trashedAssetId)}/purge/cancel`, {
        method: 'POST', headers: { ...bridgeHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ expected_revision: 1 }),
      })
      const bridgePurgeCancelBody = await bridgePurgeCancel.json()
      expect(bridgePurgeCancel.status, JSON.stringify(bridgePurgeCancelBody)).toBe(503)
      expect(JSON.stringify(bridgePurgeCancelBody)).toContain('ASSET_LIFECYCLE_UNAVAILABLE')
      const lifecycleAfterBlockedWrites = await admin.query<{ purge_requested_at: string | null; revision: number }>(
        'SELECT purge_requested_at, revision FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND asset_id=$2',
        [workspaceId, trashedAssetId],
      )
      expect(lifecycleAfterBlockedWrites.rows).toEqual(lifecycleBeforeBlockedPurge.rows)
      await stopApi(child); child = undefined
      const headers = { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId }
      const lifecycleHeaders = { ...headers, 'content-type': 'application/json' }
      // Seed an expired asset before the v256 API hydrates this workspace so
      // the worker sees the same durable snapshot as the service read model.
      const purgeAssetId = 'asset_bridge_256_worker_purge'
      const purgeBytes = Buffer.from('isolated durable asset purge bytes')
      const purgeSha256 = createHash('sha256').update(purgeBytes).digest('hex')
      const objectStore = new LocalObjectStorage(storageRoot, { maxObjectBytes: 1024 * 1024 })
      const storedPurgeObject = await objectStore.putQuarantine({ workspaceId, assetId: purgeAssetId, fileName: `${purgeAssetId}.txt`, body: purgeBytes, contentType: 'text/plain', expectedSha256: purgeSha256, expectedSizeBytes: purgeBytes.byteLength })
      await admin.query(`INSERT INTO business_entity_snapshots(workspace_id,entity_type,entity_id,entity_version,payload)
        VALUES ($1,'asset',$2,1,$3::jsonb)`, [workspaceId, purgeAssetId, JSON.stringify({ ...assetSnapshot(purgeAssetId), storageKey: storedPurgeObject.key, sha256: purgeSha256, sizeBytes: purgeBytes.byteLength })])
      await admin.query('INSERT INTO workspace_storage_quotas(workspace_id,limit_bytes,used_bytes,reserved_bytes,revision) VALUES ($1,1048576,$2,0,1)', [workspaceId, purgeBytes.byteLength])
      await admin.query(`INSERT INTO merchant_asset_lifecycle
        (workspace_id,asset_id,deleted_at,expires_at,deleted_by,revision)
        VALUES ($1,$2,now()-interval '8 days',now()-interval '1 day','bridge-actor',1)`, [workspaceId, purgeAssetId])
      const normalPort256 = await freeLoopbackPort()
      child = await startApi({ databaseUrl: appUrl.toString(), opsDatabaseUrl: opsUrl.toString(), redisUrl: fixture.redisUrl, port: normalPort256, bridgeMode: null, assetStorageRoot: storageRoot })
      expect((await fetch(`http://127.0.0.1:${normalPort256}/readyz`)).status).toBe(200)
      const activeTrash = await fetch(`http://127.0.0.1:${normalPort256}/v1/assets/trash`, { headers })
      expect(activeTrash.status).toBe(200)
      expect(await activeTrash.json()).toMatchObject({ data: { items: [expect.objectContaining({ asset: expect.objectContaining({ id: trashedAssetId }) })], total: 1, retention_days: 7 } })
      const activeAssets = await fetch(`http://127.0.0.1:${normalPort256}/v1/assets`, { headers })
      expect(activeAssets.status).toBe(200)
      const activeAssetsBody = JSON.stringify(await activeAssets.json())
      expect(activeAssetsBody).toContain(assetId)
      expect(activeAssetsBody).not.toContain(trashedAssetId)
      const trashed = await fetch(`http://127.0.0.1:${normalPort256}/v1/assets/${encodeURIComponent(assetId)}/trash`, { method: 'POST', headers: lifecycleHeaders, body: JSON.stringify({ expected_revision: 1 }) })
      expect(trashed.status).toBe(200)
      expect(await trashed.json()).toMatchObject({ data: { asset: { id: assetId }, revision: 1 } })
      const hidden = await fetch(`http://127.0.0.1:${normalPort256}/v1/assets`, { headers: lifecycleHeaders })
      expect(await hidden.json()).toMatchObject({ data: [] })
      const restored = await fetch(`http://127.0.0.1:${normalPort256}/v1/assets/${encodeURIComponent(assetId)}/restore`, { method: 'POST', headers: lifecycleHeaders, body: JSON.stringify({ expected_revision: 1 }) })
      expect(restored.status).toBe(200)
      expect(await restored.json()).toMatchObject({ data: { id: assetId, revision: 1, sourceRevision: 1 } })
      const visible = await fetch(`http://127.0.0.1:${normalPort256}/v1/assets`, { headers: lifecycleHeaders })
      expect(await visible.json()).toMatchObject({ data: [expect.objectContaining({ id: assetId })] })
      const reTrashed = await fetch(`http://127.0.0.1:${normalPort256}/v1/assets/${encodeURIComponent(assetId)}/trash`, {
        method: 'POST', headers: lifecycleHeaders, body: JSON.stringify({ expected_revision: 2 }),
      })
      expect(reTrashed.status).toBe(200)
      const reTrashedBody = await reTrashed.json() as { data: { revision: number } }
      expect(reTrashedBody.data.revision).toBe(3)
      const earlyPurge = await fetch(`http://127.0.0.1:${normalPort256}/v1/assets/${encodeURIComponent(assetId)}/purge`, {
        method: 'POST', headers: lifecycleHeaders,
        body: JSON.stringify({ confirm_asset_name: `${assetId}.txt`, reason: 'isolated PostgreSQL purge cancellation acceptance', expected_revision: reTrashedBody.data.revision }),
      })
      expect(earlyPurge.status).toBe(202)
      const earlyPurgeBody = await earlyPurge.json() as { data: { revision: number; status: string } }
      expect(earlyPurgeBody.data).toMatchObject({ revision: 4, status: 'purge_queued' })
      const queuedState = await admin.query<{ purge_requested_at: string | null; purge_request_reason: string | null; revision: number }>(
        'SELECT purge_requested_at, purge_request_reason, revision FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND asset_id=$2',
        [workspaceId, assetId],
      )
      expect(queuedState.rows).toEqual([{
        purge_requested_at: expect.any(Date),
        purge_request_reason: 'isolated PostgreSQL purge cancellation acceptance',
        revision: 4,
      }])
      const cancelledPurge = await fetch(`http://127.0.0.1:${normalPort256}/v1/assets/${encodeURIComponent(assetId)}/purge/cancel`, {
        method: 'POST', headers: lifecycleHeaders, body: JSON.stringify({ expected_revision: earlyPurgeBody.data.revision }),
      })
      expect(cancelledPurge.status).toBe(200)
      expect(await cancelledPurge.json()).toMatchObject({ data: { asset_id: assetId, revision: 5, status: 'purge_cancelled' } })
      const cancelledState = await admin.query<{ purge_requested_at: string | null; purge_request_reason: string | null; revision: number }>(
        'SELECT purge_requested_at, purge_request_reason, revision FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND asset_id=$2',
        [workspaceId, assetId],
      )
      expect(cancelledState.rows).toEqual([{ purge_requested_at: null, purge_request_reason: null, revision: 5 }])
      const lifecycleEvents = await admin.query<{ event_type: string }>(
        'SELECT event_type FROM merchant_asset_lifecycle_events WHERE workspace_id=$1 AND asset_id=$2 ORDER BY occurred_at,event_id',
        [workspaceId, assetId],
      )
      expect(lifecycleEvents.rows.map(event => event.event_type)).toEqual(['deleted', 'restored', 'deleted', 'early_purge_requested', 'purge_request_cancelled'])

      // Exercise the complete worker purge success path against the real API
      // process, app-role PostgreSQL repositories and a private local object
      // store. The old snapshot is retained by migration 256 as the source of
      // the object key, while lifecycle/events prove durable completion.
      const workerId = 'isolated-asset-purge-worker'
      const purgeBody = JSON.stringify({ workspace_id: workspaceId, limit: 1 })
      const purgeTarget = '/v1/internal/assets/lifecycle/purge'
      const proof = createWorkerRequestProof({ secret: automationSecret, role: 'automation', workerId,
        method: 'POST', requestTarget: purgeTarget, workspaceId, body: purgeBody })
      const purgedResponse = await fetch(`http://127.0.0.1:${normalPort256}${purgeTarget}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${automationToken}`, 'content-type': 'application/json',
          'x-worker-role': 'automation', 'x-worker-id': workerId, 'x-workspace-id': workspaceId,
          'x-worker-timestamp': proof.timestamp, 'x-worker-nonce': proof.nonce,
          'x-worker-body-sha256': proof.bodySha256, 'x-worker-workspace-signature': proof.signature,
        },
        body: purgeBody,
      })
      const purgeHttpBody = await purgedResponse.json()
      expect(purgedResponse.status, JSON.stringify(purgeHttpBody)).toBe(200)
      const purgeResponseBody = purgeHttpBody
      const purgeFailure = await admin.query<{ purge_error: Record<string, unknown> | null }>(
        'SELECT purge_error FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND asset_id=$2', [workspaceId, purgeAssetId],
      )
      expect(purgeResponseBody, `purge_error=${JSON.stringify(purgeFailure.rows[0]?.purge_error)}`).toMatchObject({ data: { purged: 1, retried: 0, claimed: 1, worker_id: workerId } })
      await expect(objectStore.head(workspaceId, storedPurgeObject.key, { includeQuarantine: true })).resolves.toBeNull()
      const purgedState = await admin.query<{ purged_at: Date | null; purge_lease_token: string | null; purge_lease_until: Date | null; purge_attempts: number }>(
        'SELECT purged_at,purge_lease_token,purge_lease_until,purge_attempts FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND asset_id=$2',
        [workspaceId, purgeAssetId],
      )
      expect(purgedState.rows).toEqual([{ purged_at: expect.any(Date), purge_lease_token: null, purge_lease_until: null, purge_attempts: 0 }])
      const purgeEvents = await admin.query<{ event_type: string; actor_id: string }>(
        'SELECT event_type,actor_id FROM merchant_asset_lifecycle_events WHERE workspace_id=$1 AND asset_id=$2 ORDER BY occurred_at,event_id',
        [workspaceId, purgeAssetId],
      )
      expect(purgeEvents.rows.map(event => event.event_type)).toEqual(['purge_claimed', 'purged'])
      expect(purgeEvents.rows.at(-1)?.actor_id).toBe(workerId)

    } finally {
      await stopApi(child)
      try {
        await app.end()
        await admin.end()
      } finally {
        try {
          const disposed = await fixture.dispose()
          if (disposed.leftRunning.length) throw new Error('isolated PostgreSQL fixture cleanup requires inspection')
        } finally {
          await rm(storageRoot, { recursive: true, force: true })
        }
      }
    }
  }, 300_000)
})
