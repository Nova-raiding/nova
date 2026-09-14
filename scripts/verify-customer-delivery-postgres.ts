import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Pool } from 'pg'
import { createIsolatedOpsFixture } from '../tests/isolated-ops-fixture.js'
import { CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS, PostgresCustomerDeliveryRepository } from '../packages/persistence/src/index.js'

// No inherited database URLs, tokens, or shared containers. The fixture binds
// generated credentials to exact owned tmpfs PostgreSQL/Redis containers.
const parent = resolve('artifacts/customer-delivery-postgres')
await mkdir(parent, { recursive: true, mode: 0o700 })
const evidenceDir = await mkdtemp(join(parent, 'run-'))
const observations: string[] = []
let fixture: Awaited<ReturnType<typeof createIsolatedOpsFixture>> | undefined
let ops: Pool | undefined
let app: Pool | undefined
let admin: Pool | undefined
let passed = false
let stage = 'fixture'
let disposal: unknown
try {
  fixture = await createIsolatedOpsFixture({ evidenceDir })
  ops = new Pool({ connectionString: fixture.opsDatabaseUrl, max: 3 })
  app = new Pool({ connectionString: fixture.databaseUrl, max: 1 })
  admin = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 1 })
  const repository = new PostgresCustomerDeliveryRepository(ops)
  const workspaceId = fixture.workspaceId
  const actorId = fixture.actorSubject
  const otherWorkspaceId = `ws_delivery_other_${fixture.runId}`
  await admin.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [otherWorkspaceId])
  stage = 'ops create with atomic audit'
  let record = await repository.create({ workspaceId, actorId, companyName: `QA 客户交付 ${fixture.runId}` })
  observations.push('merchant_ops creates delivery with atomic audit')

  stage = 'merchant role denied'
  for (const table of ['workspace_customer_deliveries', 'workspace_customer_delivery_checklist_items', 'workspace_customer_delivery_videos']) {
    await assert.rejects(app.query(`SELECT * FROM ${table} LIMIT 1`), { code: '42501' })
  }
  observations.push('merchant_app cannot read any delivery control-plane table after bootstrap')

  stage = 'unpaid gate'
  await assert.rejects(repository.updateChecklistItem({ workspaceId, deliveryId: record.id, actorId, checklistKey: 'system_integration', itemKey: '店铺连接', completed: true, expectedRevision: record.revision }), { code: 'PAYMENT_REQUIRED' })
  record = await repository.update({ workspaceId, id: record.id, actorId, expectedRevision: record.revision, patch: { paymentStatus: 'paid', contractNumber: 'QA-C-1', contractRef: 'https://example.com/qa-contract.pdf', projectOwner: 'QA owner', supportOwner: 'QA support', paymentDate: '2026-09-14', plannedGoLiveAt: '2026-10-01T09:00:00+08:00', customerProfileStatus: 'complete' } })
  observations.push('unpaid checklist is blocked; full profile round-trips through PostgreSQL')

  stage = 'checklist persistence'
  for (const checklistKey of ['system_integration', 'functional_acceptance'] as const) {
    const keys = CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[checklistKey]
    await repository.updateChecklistItems({ workspaceId, deliveryId: record.id, actorId, checklistKey, expectedRevision: record.revision, items: keys.map(itemKey => ({ itemKey, completed: true, evidence: { note: `QA evidence ${itemKey}` } })) })
    const items = await repository.listChecklistItems({ workspaceId, deliveryId: record.id, checklistKey })
    assert.equal(items.length, keys.length)
    assert(items.every(item => item.completed && typeof item.evidence.note === 'string'))
    record = (await repository.get(workspaceId, record.id))!
  }
  assert.equal(record.effectiveAt, null)
  observations.push('10 integration and 8 acceptance items persist with evidence; no video means inactive')

  stage = 'video and activation'
  const video = await repository.addVideo({ workspaceId, deliveryId: record.id, actorId, title: 'QA segment', assetRef: 'asset_ref_qa_delivery' })
  record = (await repository.get(workspaceId, record.id))!
  assert(record.effectiveAt)
  assert.equal(record.videos[0]?.id, video.id)
  observations.push('video reference and complete delivery generate persisted effective time (asset scanning belongs to API and is not claimed here)')

  stage = 'single-item activation recalculation'
  await repository.updateChecklistItem({ workspaceId, deliveryId: record.id, actorId, checklistKey: 'system_integration', itemKey: '店铺连接', completed: false, evidence: { note: 'QA reopened' }, expectedRevision: record.revision })
  record = (await repository.get(workspaceId, record.id))!
  assert.equal(record.systemIntegrationStatus, 'incomplete')
  assert.equal(record.effectiveAt, null)
  await repository.updateChecklistItem({ workspaceId, deliveryId: record.id, actorId, checklistKey: 'system_integration', itemKey: '店铺连接', completed: true, evidence: { note: 'QA restored' }, expectedRevision: record.revision })
  record = (await repository.get(workspaceId, record.id))!
  assert(record.effectiveAt)
  observations.push('single-item reopen/restore immediately recalculates effective time')

  stage = 'concurrent revisions'
  const concurrent = await Promise.allSettled(['QA owner A', 'QA owner B'].map(projectOwner => repository.update({ workspaceId, id: record.id, actorId, expectedRevision: record.revision, patch: { projectOwner } })))
  assert.equal(concurrent.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(concurrent.filter(item => item.status === 'rejected' && item.reason?.code === 'REVISION_CONFLICT').length, 1)
  record = (await repository.get(workspaceId, record.id))!
  record = await repository.update({ workspaceId, id: record.id, actorId, expectedRevision: record.revision, patch: { paymentStatus: 'unpaid' } })
  assert.equal(record.effectiveAt, null)
  observations.push('stale concurrent update rejected; payment revocation clears effective time')

  stage = 'RLS and append-only audit'
  const client = await ops.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [otherWorkspaceId])
    assert.equal((await client.query('SELECT id FROM workspace_customer_deliveries WHERE id=$1', [record.id])).rowCount, 0)
    await client.query('ROLLBACK')
  } finally { client.release() }
  const audit = await admin.query("SELECT before_json, after_json FROM workspace_operation_audit WHERE workspace_id=$1 AND action='customer_delivery.checklist_item.update' ORDER BY created_at", [workspaceId])
  assert.equal(audit.rowCount, 2)
  assert.equal(audit.rows[0].before_json.completed, true)
  await assert.rejects(ops.query('DELETE FROM workspace_operation_audit WHERE false'), { code: '42501' })
  await assert.rejects(ops.query('UPDATE workspace_operation_audit SET reason=reason WHERE false'), { code: '42501' })
  observations.push('cross-workspace reads are hidden; audit has real before-state and cannot be mutated by ops')

  stage = 'video retention'
  await repository.removeVideo({ workspaceId, deliveryId: record.id, videoId: video.id, actorId })
  const retained = await admin.query('SELECT deleted_at FROM workspace_customer_delivery_videos WHERE id=$1', [video.id])
  assert(retained.rows[0]?.deleted_at)
  await assert.rejects(ops.query('DELETE FROM workspace_customer_delivery_videos WHERE false'), { code: '42501' })
  observations.push('video removal is soft-delete; physical delete denied')
  passed = true
} catch (error) {
  // Never print native connection errors or credentials.
  const code = (error as { code?: unknown })?.code
  observations.push(`FAILED at ${stage}; code=${typeof code === 'string' ? code : 'RUNTIME_ASSERTION_FAILED'}`)
} finally {
  await Promise.all([ops?.end(), app?.end(), admin?.end()])
  if (fixture) {
    const result = await fixture.dispose()
    disposal = result
    if (result.leftRunning.length) {
      passed = false
      observations.push('FAILED: owned fixture cleanup incomplete; shared containers untouched')
    }
  }
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify({ status: passed ? 'passed' : 'failed', stage, at: new Date().toISOString(), fixtureOnly: true, sharedContainersTouched: false, observations, disposal }, null, 2), { mode: 0o600, flag: 'wx' })
}
console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', stage, observations, evidenceDir }, null, 2))
process.exitCode = passed ? 0 : 1
