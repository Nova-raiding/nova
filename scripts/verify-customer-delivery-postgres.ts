import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Pool } from 'pg'
import { createIsolatedOpsFixture } from '../tests/isolated-ops-fixture.js'
import { CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS, PostgresCustomerDeliveryRepository, loadMigrations, migrationChecksum, MigrationRunner, withWorkspaceTransaction } from '../packages/persistence/src/index.js'

// This command proves schema/repository fail-closed behavior, NOT scanner
// acceptance. These refs deliberately have no asset, receipt, signed admission
// or object. Never manufacture those to make a success path pass: the separate
// seven-attachment browser run supplies actual signed scanner evidence.
const syntheticRefs = {
  contract: 'asset_ref_unverified_repository_contract',
  payment: 'asset_ref_unverified_repository_payment',
  system_integration: 'asset_ref_unverified_repository_integration',
  functional_acceptance: 'asset_ref_unverified_repository_acceptance',
  training: 'asset_ref_unverified_repository_training',
  video: 'asset_ref_unverified_repository_video',
}
const parent = resolve('artifacts/customer-delivery-postgres')
await mkdir(parent, { recursive: true, mode: 0o700 })
const evidenceDir = await mkdtemp(join(parent, 'run-'))
const sourceFiles = ['packages/persistence/src/customer-delivery-repository.ts', 'scripts/verify-customer-delivery-postgres.ts']
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async path =>
  [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
const sourcesBefore = await sourceHashes()
const migrations = await loadMigrations()
const latestVersion = migrations.at(-1)!.version
const expectedMigrations = migrations.map(({ version, sql }) => ({ version, checksum: migrationChecksum(sql) }))
assert(latestVersion >= 204, 'atomic evidence migration is required')
const observations: string[] = []
const timestampOffsetEvidence: { offset: string; postgresAccepted: boolean; sqlState: string | null }[] = []
let fixture: Awaited<ReturnType<typeof createIsolatedOpsFixture>> | undefined
let ops: Pool | undefined, app: Pool | undefined, admin: Pool | undefined
let legacyAdmin: Pool | undefined, legacyOps: Pool | undefined
let legacyEvidence: Record<string, unknown> | undefined
let sourcesAfter: Record<string, string> | undefined
let passed = false
let stage = 'fixture'
let disposal: unknown

// Hash all relevant contents, not just counts. Rejected writes must not alter
// values, revisions, tombstones or append a success audit.
async function footprint(pool: Pool, workspaceId: string) {
  return (await pool.query(
    "SELECT " +
    "(SELECT md5(COALESCE(jsonb_agg(to_jsonb(d) ORDER BY id)::text,'[]')) FROM workspace_customer_deliveries d WHERE workspace_id=$1) AS deliveries," +
    "(SELECT md5(COALESCE(jsonb_agg(to_jsonb(i) ORDER BY delivery_id,checklist_key,item_key)::text,'[]')) FROM workspace_customer_delivery_checklist_items i WHERE workspace_id=$1) AS items," +
    "(SELECT md5(COALESCE(jsonb_agg(to_jsonb(v) ORDER BY id)::text,'[]')) FROM workspace_customer_delivery_videos v WHERE workspace_id=$1) AS videos," +
    "(SELECT md5(COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id)::text,'[]')) FROM workspace_operation_audit a WHERE workspace_id=$1) AS audits",
    [workspaceId])).rows[0]
}
async function rejectWithoutMutation(pool: Pool, workspaceId: string, work: () => Promise<unknown>, code: string) {
  const before = await footprint(pool, workspaceId)
  await assert.rejects(work(), { code })
  assert.deepEqual(await footprint(pool, workspaceId), before)
}
async function assertNoTrustedEvidenceCreated(pool: Pool, workspaceId: string) {
  assert.deepEqual((await pool.query(
    "SELECT (SELECT count(*)::integer FROM asset_scan_receipts WHERE workspace_id=$1) AS receipts," +
    "(SELECT count(*)::integer FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='asset') AS assets," +
    "(SELECT count(*)::integer FROM outbox_events WHERE workspace_id=$1 AND event_type IN ('asset.customer_delivery_quarantined','customer_delivery.asset.upload_reused')) AS admissions",
    [workspaceId])).rows[0], { receipts: 0, assets: 0, admissions: 0 })
}

try {
  fixture = await createIsolatedOpsFixture({ evidenceDir })
  ops = new Pool({ connectionString: fixture.opsDatabaseUrl, max: 3, connectionTimeoutMillis: 2000, statement_timeout: 15_000 })
  app = new Pool({ connectionString: fixture.databaseUrl, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 15_000 })
  admin = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 15_000 })
  assert.deepEqual((await admin.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows, expectedMigrations)
  stage = 'read-only PostgreSQL numeric timezone offset boundary'
  // Probe the real PG 17 parser, without creating/updating a business record.
  // Its MAX_TZDISP_HOUR is 15; JavaScript Date.parse also accepts 16..23,
  // so a successful JS parse alone is insufficient API storage validation.
  for (const offset of ['+08:00', '+15:59', '-15:59', '+16:00', '-16:00', '+23:59', '-23:59']) {
    try {
      const parsed = (await admin.query('SELECT $1::timestamptz AS parsed', ['2026-10-01T09:00:00' + offset])).rows[0]?.parsed
      assert(parsed instanceof Date && Number.isFinite(parsed.valueOf()))
      timestampOffsetEvidence.push({ offset, postgresAccepted: true, sqlState: null })
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (typeof code !== 'string' || !/^22\d{3}$/u.test(code)) throw error
      timestampOffsetEvidence.push({ offset, postgresAccepted: false, sqlState: code })
    }
  }
  assert.deepEqual(timestampOffsetEvidence.map(({ postgresAccepted, sqlState }) => ({ postgresAccepted, sqlState })), [
    ...Array.from({ length: 3 }, () => ({ postgresAccepted: true, sqlState: null })),
    ...Array.from({ length: 4 }, () => ({ postgresAccepted: false, sqlState: '22009' })),
  ])
  observations.push('read-only PG timestamp parser accepts ±15:59 but rejects ±16:00 and ±23:59 with SQLSTATE 22009; this is storage-boundary evidence, not API validation acceptance')
  const repository = new PostgresCustomerDeliveryRepository(ops)
  const workspaceId = fixture.workspaceId, actorId = fixture.actorSubject
  const otherWorkspaceId = 'ws_delivery_other_' + fixture.runId
  await admin.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [otherWorkspaceId])
  stage = 'ops draft create and full profile round-trip'
  let record = await repository.create({ workspaceId, actorId, companyName: 'QA 客户交付 ' + fixture.runId })
  record = await repository.update({ workspaceId, id: record.id, actorId, expectedRevision: record.revision, patch: {
    contractNumber: 'QA-C-1', contractRef: 'https://example.invalid/qa-contract.pdf', projectOwner: 'QA owner', supportOwner: 'QA support',
    paymentDate: '2026-09-14', plannedGoLiveAt: '2026-10-01T09:00:00+08:00', customerProfileStatus: 'complete',
  } })
  assert.equal(record.paymentStatus, 'unpaid'); assert.equal(record.trainingCompleted, false); assert.equal(record.effectiveAt, null)
  assert.equal(record.paymentDate, '2026-09-14'); assert.equal(record.plannedGoLiveAt, '2026-10-01T01:00:00.000Z')
  assert.equal(record.contractNumber, 'QA-C-1'); assert.equal(record.contractRef, 'https://example.invalid/qa-contract.pdf')
  assert.equal(record.projectOwner, 'QA owner'); assert.equal(record.supportOwner, 'QA support')
  record = await repository.update({ workspaceId, id: record.id, actorId, expectedRevision: record.revision, patch: { paymentDate: null } })
  assert.equal(record.paymentDate, null)
  const noOpBefore = await footprint(admin, workspaceId)
  assert.deepEqual(await repository.update({ workspaceId, id: record.id, actorId, expectedRevision: record.revision, patch: {} }), record)
  assert.deepEqual(await footprint(admin, workspaceId), noOpBefore)
  observations.push('full profile fields persist; local DATE/zoned timestamp round-trip; unpaid date clears to NULL; empty patch is a true no-op')

  stage = 'unpaid and missing-evidence gates'
  await rejectWithoutMutation(admin, workspaceId, () => repository.updateChecklistItem({ workspaceId, deliveryId: record.id, actorId, checklistKey: 'system_integration', itemKey: '店铺连接', completed: true,
    evidence: { note: 'Unverified input', asset_refs: [syntheticRefs.system_integration] }, expectedRevision: record.revision }), 'PAYMENT_REQUIRED')
  for (const patch of [{ paymentStatus: 'paid' as const, paymentDate: '2026-09-14' }, { trainingCompleted: true }]) {
    await rejectWithoutMutation(admin, workspaceId, () => repository.update({ workspaceId, id: record.id, actorId, expectedRevision: record.revision, patch }), 'EVIDENCE_REQUIRED')
  }
  for (const [purpose, assetRef] of Object.entries(syntheticRefs)) {
    await rejectWithoutMutation(admin, workspaceId, () => withWorkspaceTransaction(ops!, workspaceId, client => client.query(
      'SELECT public.assert_customer_delivery_evidence_asset($1,$2,$3,$4)', [workspaceId, record.id, purpose, assetRef])), '23514')
  }
  for (const patch of [{ contractRef: syntheticRefs.contract }, { paymentStatus: 'paid' as const, paymentDate: '2026-09-14', paymentEvidenceRefs: [syntheticRefs.payment] }, { trainingEvidenceRefs: [syntheticRefs.training] }]) {
    await rejectWithoutMutation(admin, workspaceId, () => repository.update({ workspaceId, id: record.id, actorId, expectedRevision: record.revision, patch }), '23514')
  }
  await rejectWithoutMutation(admin, workspaceId, () => repository.addVideo({ workspaceId, deliveryId: record.id, actorId, title: 'Unverified video', assetRef: syntheticRefs.video }), '23514')
  observations.push('all six purposes reject nonexistent refs; unpaid checklist and missing/fake proof writes leave parent, children and audit unchanged')

  stage = 'concurrent profile revision and audit'
  const concurrent = await Promise.allSettled(['QA owner A', 'QA owner B'].map(projectOwner => repository.update({ workspaceId, id: record.id, actorId, expectedRevision: record.revision, patch: { projectOwner } })))
  assert.equal(concurrent.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(concurrent.filter(item => item.status === 'rejected' && item.reason?.code === 'REVISION_CONFLICT').length, 1)
  const profileAudit = await admin.query("SELECT before_json,after_json FROM workspace_operation_audit WHERE workspace_id=$1 AND resource_id=$2 AND action='customer_delivery.update' AND after_json->>'projectOwner' IN ('QA owner A','QA owner B')", [workspaceId, record.id])
  assert.equal(profileAudit.rowCount, 1)
  assert.equal(profileAudit.rows[0].before_json.projectOwner, 'QA owner')
  assert.equal(profileAudit.rows[0].after_json.revision, record.revision + 1)
  observations.push('one concurrent update commits and one stale revision fails; audit retains actual before-state')

  stage = 'runtime roles, cross-workspace RLS and append-only audit'
  for (const table of ['workspace_customer_deliveries', 'workspace_customer_delivery_checklist_items', 'workspace_customer_delivery_videos']) {
    await assert.rejects(app.query('SELECT * FROM ' + table + ' LIMIT 1'), { code: '42501' })
  }
  assert.equal((await withWorkspaceTransaction(ops, otherWorkspaceId, client => client.query('SELECT id FROM workspace_customer_deliveries WHERE id=$1', [record.id]))).rowCount, 0)
  await assert.rejects(withWorkspaceTransaction(ops, otherWorkspaceId, client => client.query(
    'SELECT public.assert_customer_delivery_evidence_asset($1,$2,$3,$4)', [workspaceId, record.id, 'payment', syntheticRefs.payment])), { code: '42501' })
  await assert.rejects(app.query('SELECT public.assert_customer_delivery_evidence_asset($1,$2,$3,$4)', [workspaceId, record.id, 'payment', syntheticRefs.payment]), { code: '42501' })
  await assert.rejects(ops.query('DELETE FROM workspace_operation_audit WHERE false'), { code: '42501' })
  await assert.rejects(ops.query('UPDATE workspace_operation_audit SET reason=reason WHERE false'), { code: '42501' })
  await assertNoTrustedEvidenceCreated(admin, workspaceId)
  observations.push('merchant_app cannot access delivery control plane/validator; cross-workspace denied; ops audit append-only; no trusted evidence fabricated')

  stage = 'legacy migration 200 seed'
  // Create only a uniquely named database in the verified owned tmpfs PG.
  // No shared URL is read, no trigger is bypassed, no database is dropped.
  const legacyName = 'delivery_upgrade_' + fixture.runId.replaceAll('-', '')
  assert.match(legacyName, /^delivery_upgrade_[a-f0-9]{32}$/u)
  const fixtureAdminUrl = new URL(fixture.adminDatabaseUrl), fixtureAppUrl = new URL(fixture.databaseUrl)
  assert.equal(fixtureAdminUrl.hostname, '127.0.0.1'); assert.equal(fixtureAdminUrl.host, fixtureAppUrl.host)
  assert.equal(fixtureAdminUrl.pathname, '/merchant'); assert.equal(fixtureAdminUrl.username, 'merchant')
  assert(fixture.containerEvidence.some(container => container.kind === 'postgres' && container.runId === fixture!.runId
    && container.hostPort === Number(fixtureAdminUrl.port) && container.dataStorage === 'tmpfs'))
  await admin.query('CREATE DATABASE "' + legacyName + '"')
  const legacyAdminUrl = new URL(fixtureAdminUrl); legacyAdminUrl.pathname = '/' + legacyName
  const legacyOpsUrl = new URL(fixture.opsDatabaseUrl); legacyOpsUrl.pathname = '/' + legacyName
  assert.equal(legacyOpsUrl.host, fixtureAdminUrl.host); assert.equal(legacyOpsUrl.username, 'merchant_ops')
  legacyAdmin = new Pool({ connectionString: legacyAdminUrl.toString(), max: 1, connectionTimeoutMillis: 2000, statement_timeout: 15_000 })
  legacyOps = new Pool({ connectionString: legacyOpsUrl.toString(), max: 1, connectionTimeoutMillis: 2000, statement_timeout: 15_000 })
  assert.equal((await new MigrationRunner(legacyAdmin, migrations.filter(migration => migration.version <= 200)).run()).length, 200)
  const legacyWorkspace = 'ws_delivery_legacy_' + fixture.runId, legacyId = 'cd_legacy_' + fixture.runId
  const historicalEffective = '2026-09-01T01:00:00.000Z'
  await legacyAdmin.query("INSERT INTO workspaces(id,status) VALUES ($1,'active')", [legacyWorkspace])
  await legacyAdmin.query(
    "INSERT INTO workspace_customer_deliveries (id,workspace_id,company_name,contract_number,payment_status,contract_ref,project_owner,support_owner,payment_date,planned_go_live_at,customer_profile_status,system_integration_status,functional_acceptance_status,training_completed,effective_at,created_by_actor_id,updated_by_actor_id) " +
    "VALUES ($1,$2,'Unverified pre-201 customer','LEGACY-QA','paid','https://example.invalid/legacy-contract.pdf','Legacy project owner','Legacy support owner','2026-09-01','2026-10-01T01:00:00Z','complete','complete','complete',true,$3,$4,$4)",
    [legacyId, legacyWorkspace, historicalEffective, actorId])
  for (const checklistKey of ['system_integration', 'functional_acceptance'] as const) {
    for (const itemKey of CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[checklistKey]) {
      await legacyAdmin.query("INSERT INTO workspace_customer_delivery_checklist_items (workspace_id,delivery_id,checklist_key,item_key,completed,evidence,completed_by_actor_id,completed_at) VALUES ($1,$2,$3,$4,true,$5::jsonb,$6,now())",
        [legacyWorkspace, legacyId, checklistKey, itemKey, JSON.stringify({ note: 'Historical unverified note: ' + itemKey, asset_refs: [syntheticRefs[checklistKey]] }), actorId])
    }
  }
  for (const suffix of ['one', 'two']) {
    await legacyAdmin.query('INSERT INTO workspace_customer_delivery_videos(id,workspace_id,delivery_id,title,asset_ref,uploaded_by_actor_id) VALUES ($1,$2,$3,$4,$5,$6)',
      ['cdv_legacy_' + suffix + '_' + fixture.runId, legacyWorkspace, legacyId, 'Unverified historical video ' + suffix, syntheticRefs.video, actorId])
  }
  stage = 'legacy migration 201 then 202'
  assert.deepEqual(await new MigrationRunner(legacyAdmin, migrations.filter(migration => migration.version <= 201)).run(), [201])
  const migration201 = (await legacyAdmin.query('SELECT checksum FROM schema_migrations WHERE version=201')).rows[0]?.checksum
  assert.equal(typeof migration201, 'string')
  assert.deepEqual(await new MigrationRunner(legacyAdmin, migrations.filter(migration => migration.version <= 202)).run(), [202])
  // Model old structural data: nonexistent refs, NOT fake clean assets.
  await legacyAdmin.query('UPDATE workspace_customer_deliveries SET payment_evidence_refs=ARRAY[$3],training_evidence_refs=ARRAY[$4] WHERE workspace_id=$1 AND id=$2',
    [legacyWorkspace, legacyId, syntheticRefs.payment, syntheticRefs.training])
  const legacyBeforeUpgrade = await footprint(legacyAdmin, legacyWorkspace)
  stage = 'legacy upgrade to current complete migration chain'
  const appliedTail = await new MigrationRunner(legacyAdmin, migrations).run()
  assert.deepEqual(appliedTail, migrations.filter(migration => migration.version > 202).map(migration => migration.version))
  assert.deepEqual((await legacyAdmin.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows, expectedMigrations)
  assert.equal((await legacyAdmin.query('SELECT checksum FROM schema_migrations WHERE version=201')).rows[0]?.checksum, migration201)
  assert.deepEqual(await footprint(legacyAdmin, legacyWorkspace), legacyBeforeUpgrade)
  const legacyRole = (await legacyOps.query('SELECT current_user AS role,current_database() AS database,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
  assert.deepEqual(legacyRole, { role: 'merchant_ops', database: legacyName, rolsuper: false, rolbypassrls: false })
  observations.push('real 200→201→202→' + latestVersion + ' upgrade preserves historical rows, 18 items, videos and audit; 201 checksum unchanged')

  stage = 'unverified structurally complete legacy reads fail closed'
  const legacyRepository = new PostgresCustomerDeliveryRepository(legacyOps)
  const beforeLegacyReads = await footprint(legacyAdmin, legacyWorkspace)
  let legacy = (await legacyRepository.get(legacyWorkspace, legacyId))!
  assert.equal(legacy.paymentStatus, 'paid'); assert.equal(legacy.trainingCompleted, true)
  assert.equal(legacy.effectiveAt, null, 'historical effective_at plus nonexistent refs must not appear ready')
  assert.equal((await legacyRepository.list({ workspaceId: legacyWorkspace })).items.find(item => item.id === legacyId)?.effectiveAt, null)
  assert.deepEqual(await footprint(legacyAdmin, legacyWorkspace), beforeLegacyReads)
  const rawLegacy = (await legacyAdmin.query('SELECT payment_status,training_completed,effective_at FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2', [legacyWorkspace, legacyId])).rows[0]
  assert.equal(new Date(rawLegacy.effective_at).toISOString(), historicalEffective)
  assert.equal(rawLegacy.payment_status, 'paid'); assert.equal(rawLegacy.training_completed, true)
  observations.push('get/list mask unverified historical effectiveness despite complete structural fields; reads preserve raw facts and audit')

  stage = 'unverified legacy completion mutation is atomic'
  await rejectWithoutMutation(legacyAdmin, legacyWorkspace, () => legacyRepository.update({ workspaceId: legacyWorkspace, id: legacyId, actorId, expectedRevision: legacy.revision,
    patch: { projectOwner: 'Must not reactivate unverified legacy' } }), '23514')
  for (const checklistKey of ['system_integration', 'functional_acceptance'] as const) {
    const keys = CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[checklistKey]
    const persisted = await legacyRepository.listChecklistItems({ workspaceId: legacyWorkspace, deliveryId: legacyId, checklistKey })
    assert.equal(persisted.length, keys.length)
    assert(persisted.every(item => item.completed && typeof item.evidence.note === 'string'))
    await rejectWithoutMutation(legacyAdmin, legacyWorkspace, () => legacyRepository.updateChecklistItems({ workspaceId: legacyWorkspace, deliveryId: legacyId, actorId, checklistKey,
      expectedRevision: legacy.revision, items: keys.map(itemKey => ({ itemKey, completed: true, evidence: { note: 'Unverified repair ' + itemKey, asset_refs: [syntheticRefs[checklistKey]] } })) }), '23514')
  }
  observations.push('18 legacy keys/notes/refs round-trip; nonexistent evidence cannot be resaved or reactivate completion; failed writes roll back')

  stage = 'legacy safe downgrade repair and soft-delete retention'
  legacy = await legacyRepository.update({ workspaceId: legacyWorkspace, id: legacyId, actorId, expectedRevision: legacy.revision,
    patch: { customerProfileStatus: 'incomplete', projectOwner: 'Legacy repair remains editable' } })
  assert.equal(legacy.paymentStatus, 'paid'); assert.equal(legacy.trainingCompleted, true); assert.equal(legacy.effectiveAt, null)
  const repairAudit = (await legacyAdmin.query("SELECT before_json,after_json FROM workspace_operation_audit WHERE workspace_id=$1 AND resource_id=$2 AND action='customer_delivery.update' ORDER BY created_at,id", [legacyWorkspace, legacyId])).rows.at(-1)!
  assert.equal(repairAudit.before_json.effectiveAt, historicalEffective)
  assert.equal(repairAudit.before_json.videos.length, 2)
  assert.deepEqual(repairAudit.before_json.videos, repairAudit.after_json.videos)
  legacy = await legacyRepository.update({ workspaceId: legacyWorkspace, id: legacyId, actorId, expectedRevision: legacy.revision, patch: { trainingCompleted: false, trainingEvidenceRefs: [] } })
  legacy = await legacyRepository.update({ workspaceId: legacyWorkspace, id: legacyId, actorId, expectedRevision: legacy.revision, patch: { paymentStatus: 'unpaid', paymentDate: null, paymentEvidenceRefs: [] } })
  assert.equal(legacy.trainingCompleted, false); assert.equal(legacy.paymentStatus, 'unpaid'); assert.equal(legacy.paymentDate, null)
  const videoId = 'cdv_legacy_one_' + fixture.runId
  await legacyRepository.removeVideo({ workspaceId: legacyWorkspace, deliveryId: legacyId, videoId, actorId })
  assert((await legacyAdmin.query('SELECT deleted_at FROM workspace_customer_delivery_videos WHERE workspace_id=$1 AND id=$2', [legacyWorkspace, videoId])).rows[0]?.deleted_at)
  assert.equal((await legacyAdmin.query('SELECT count(*)::integer AS count FROM workspace_customer_delivery_videos WHERE workspace_id=$1 AND delivery_id=$2', [legacyWorkspace, legacyId])).rows[0]?.count, 2)
  await assert.rejects(legacyOps.query('DELETE FROM workspace_customer_delivery_videos WHERE false'), { code: '42501' })
  observations.push('explicit draft downgrade allows progressive training/payment repair; audit preserves historic videos/effective time; video removal only tombstones')

  stage = 'direct SQL structural guards and no manufactured scan evidence'
  const fresh = await legacyRepository.create({ workspaceId: legacyWorkspace, actorId, companyName: 'New evidence guard ' + fixture.runId })
  await rejectWithoutMutation(legacyAdmin, legacyWorkspace, () => withWorkspaceTransaction(legacyOps!, legacyWorkspace, client => client.query(
    "INSERT INTO workspace_customer_deliveries (id,workspace_id,company_name,payment_status,payment_date,created_by_actor_id,updated_by_actor_id) VALUES ($1,$2,'Rejected direct insert','paid','2026-09-14',$3,$3)",
    ['cd_invalid_' + fixture!.runId, legacyWorkspace, actorId])), '23514')
  for (const assignment of ["payment_status='paid',payment_date='2026-09-14'", 'training_completed=true']) {
    await rejectWithoutMutation(legacyAdmin, legacyWorkspace, () => withWorkspaceTransaction(legacyOps!, legacyWorkspace, client => client.query(
      'UPDATE workspace_customer_deliveries SET ' + assignment + ' WHERE workspace_id=$1 AND id=$2', [legacyWorkspace, fresh.id])), '23514')
  }
  await assertNoTrustedEvidenceCreated(legacyAdmin, legacyWorkspace)
  legacyEvidence = { upgradedFrom: 200, applied: [201, 202, ...appliedTail], migration201ChecksumPreserved: true,
    rawHistoricalFactsPreservedByMigration: true, unverifiedEffectiveAtMaskedOnRead: true, legacyReadsDoNotMutateRowsOrAudit: true,
    historicalChecklistRows: 18, invalidWritesAtomic: true, safeDowngradeRepairsAudited: true, videoSoftDeleteRetainsRows: true,
    schemaBypassUsed: false, databaseDropped: false, nonexistentHistoricalRefsOnly: true, manufacturedTrustedEvidence: false,
    runtimeRole: legacyRole.role, runtimeRoleBypassRls: legacyRole.rolbypassrls }
  sourcesAfter = await sourceHashes()
  assert.deepEqual(sourcesAfter, sourcesBefore, 'runtime source changed during verification; rerun stable snapshot')
  assert.deepEqual((await loadMigrations()).map(({ version, sql }) => ({ version, checksum: migrationChecksum(sql) })), expectedMigrations,
    'migration source changed during verification; rerun stable snapshot')
  passed = true
} catch (error) {
  // Never print native connection errors, generated URLs, or credentials.
  const code = (error as { code?: unknown })?.code
  observations.push('FAILED at ' + stage + '; code=' + (typeof code === 'string' ? code : 'RUNTIME_ASSERTION_FAILED'))
} finally {
  const poolsClosed = await Promise.allSettled([legacyOps?.end(), legacyAdmin?.end(), ops?.end(), app?.end(), admin?.end()])
  if (poolsClosed.some(result => result.status === 'rejected')) {
    passed = false
    observations.push('FAILED: pool close failed; still attempting exact owned fixture cleanup')
  }
  if (fixture) {
    const result = await fixture.dispose()
    disposal = result
    if (result.leftRunning.length) {
      passed = false
      observations.push('FAILED: owned fixture cleanup incomplete; shared containers untouched')
    }
  }
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify({ status: passed ? 'passed' : 'failed', stage, at: new Date().toISOString(), fixtureOnly: true,
    verificationScope: 'real-postgres-current-schema-repository-and-untrusted-evidence-fail-closed', realScannerAcceptance: false,
    manufacturedTrustedEvidence: false, latestMigrationVersion: latestVersion, migrationChecksums: expectedMigrations,
    sourcesBefore, sourcesAfter, sharedContainersTouched: false, observations, timestampOffsetEvidence, legacyEvidence, disposal }, null, 2), { mode: 0o600, flag: 'wx' })
}
console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', stage, observations, evidenceDir }, null, 2))
process.exitCode = passed ? 0 : 1
