import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { PostgresCustomerDeliveryRepository, loadMigrations, migrationChecksum } from '../packages/persistence/src/index.js'
import { runOpsE2e, type OpsE2eContext } from './run-ops-password-e2e.js'

// Runs only the runner-owned PG/Redis/password-session/ClamAV fixture. The scanner collector
// must pass before this additional adverse probe touches an uploaded asset.
// No receipt/admission/clean verdict is synthesized or restored by this script.
const sources = [
  'packages/contracts/src/authz.ts',
  'packages/persistence/src/customer-delivery-repository.ts',
  'apps/api/src/server.ts', 'apps/api/src/customer-delivery-profile-validation.ts',
  'apps/ops-console/src/components/delivery/CustomerDeliverySection.tsx',
  'apps/ops-console/src/components/delivery/CustomerDeliveryUpload.tsx',
  'apps/ops-console/src/components/delivery/deliveryDateTime.ts',
  'apps/ops-console/src/api/customerDeliveryClient.ts',
  'apps/ops-console/src/pages/CustomerDeliveryPage.tsx',
  'dogfood/chatgpt-all-functions/ops-delivery-owner-acceptance.spec.js',
  'scripts/run-ops-password-e2e.ts',
  'scripts/ops-e2e-child-monitor.ts',
  'scripts/customer-delivery-scan-fixture.ts',
  'scripts/customer-delivery-scan-evidence.ts', 'scripts/verify-customer-delivery-owner.ts',
]
const fingerprint = async () => ({
  sources: Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))),
  migrations: (await loadMigrations()).map(({ version, sql }) => ({ version, checksum: migrationChecksum(sql) })),
})

async function collectRejectedAttachmentDiagnostics({ fixture, evidenceDir }: OpsE2eContext) {
  const pool = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 1, connectionTimeoutMillis: 2_000, statement_timeout: 10_000 })
  try {
    // Only discriminants from this owned fixture: no raw receipt, signature,
    // actor, file body, object key or credential is exported. Never write DB.
    const result = await pool.query(`SELECT e.aggregate_id AS asset_id,
      s.payload->>'scanStatus' AS scan_status,
      public.asset_snapshot_is_trusted_clean(s.workspace_id,s.entity_id,s.payload) AS trusted_clean,
      s.payload->>'sourceRevision' AS asset_source_revision,
      e.payload->'delivery_scan_admission'->>'source_revision' AS admission_source_revision,
      e.payload->'delivery_scan_admission'->>'purpose' AS purpose,
      e.payload->'delivery_scan_admission'->>'schema_version' AS schema_version,
      e.payload->'delivery_scan_admission'->>'operation' AS operation,
      e.payload->'delivery_scan_admission'->>'workbench' AS workbench,
      e.payload->'delivery_scan_admission'->>'context_id' AS context_id,
      e.payload->'delivery_scan_admission'->>'capability' AS capability,
      e.payload->'delivery_scan_admission'->>'authorized' AS authorized,
      e.payload->'delivery_scan_admission'->>'workspace_id'=e.workspace_id AS admission_workspace_matches,
      e.payload->'delivery_scan_admission'->>'asset_id'=e.aggregate_id AS admission_asset_matches,
      d.id IS NOT NULL AS delivery_exists,
      a.decision_id IS NOT NULL AS authorization_exists,a.method AS authorization_method,
      a.capability AS authorization_capability,a.workbench AS authorization_workbench,a.result AS authorization_result,
      a.actor_id=e.payload->'delivery_scan_admission'->>'actor_id' AS authorization_actor_matches,
      a.request_id=e.payload->'delivery_scan_admission'->>'request_id' AS authorization_request_matches,
      a.trace_id=e.payload->'delivery_scan_admission'->>'trace_id' AS authorization_trace_matches,
      r.receipt_id IS NOT NULL AS receipt_exists,
      r.receipt->'subject'->>'mime_type'=s.payload->>'mimeType' AS receipt_mime_matches,
      r.receipt->'subject'->>'sha256'=s.payload->>'sha256' AS receipt_sha_matches,
      r.receipt->'subject'->>'size_bytes'=s.payload->>'sizeBytes' AS receipt_size_matches
      FROM outbox_events e
      LEFT JOIN business_entity_snapshots s ON s.workspace_id=e.workspace_id AND s.entity_type='asset' AND s.entity_id=e.aggregate_id
      LEFT JOIN workspace_customer_deliveries d ON d.workspace_id=e.workspace_id AND d.id=e.payload->'delivery_scan_admission'->>'delivery_id'
      LEFT JOIN platform_authorization_audit a ON a.decision_id=e.payload->'delivery_scan_admission'->>'decision_id'
      LEFT JOIN asset_scan_receipts r ON r.workspace_id=e.workspace_id AND r.receipt_id=s.payload->>'scanReceiptId'
      WHERE e.workspace_id=$1 AND e.event_type='asset.customer_delivery_quarantined' ORDER BY e.created_at,e.id`, [fixture.workspaceId])
    await writeFile(join(evidenceDir, 'owner-attachment-diagnostics.json'), JSON.stringify({ status: 'diagnostic_only', fixtureRunId: fixture.runId,
      rows: result.rows, businessWrites: false, rawReceiptsOrSignaturesExported: false }, null, 2), { mode: 0o600, flag: 'wx' })
  } finally { await pool.end() }
}

async function probeInvalidation(context: OpsE2eContext, beforeSources: Awaited<ReturnType<typeof fingerprint>>) {
  const { fixture, evidenceDir } = context
  const report: Record<string, unknown> = { status: 'failed', fixtureRunId: fixture.runId,
    verificationScope: 'genuine-scanned-evidence-revocation-concurrency', sharedContainersTouched: false,
    receiptsManufactured: false, cleanEvidenceRestored: false, sourcesBefore: beforeSources }
  let stage = 'require-passed-seven-attachment-collector'
  let admin: Pool | undefined, ops: Pool | undefined
  let revoker: PoolClient | undefined
  let mutation: Promise<{ code?: string; fulfilled: boolean }> | undefined
  let transactionOpen = false
  try {
    const scan = JSON.parse(await readFile(join(evidenceDir, 'scan-result.json'), 'utf8'))
    assert.equal(scan.status, 'passed')
    assert.equal(scan.attachments.length, 7)
    assert.deepEqual(await fingerprint(), beforeSources, 'source changed before live probe; rerun stable snapshot')
    const deliveryIds = [...new Set(scan.attachments.map((attachment: { deliveryId: unknown }) => attachment.deliveryId))]
    assert.equal(deliveryIds.length, 1, 'all seven verified attachments must belong to one delivery')
    const deliveryId = deliveryIds[0] as string
    const assetId = scan.attachments.find((attachment: { purpose: string }) => attachment.purpose === 'payment')?.assetId
    assert.equal(typeof deliveryId, 'string'); assert.equal(typeof assetId, 'string')
    assert(fixture.containerEvidence.some(container => container.kind === 'postgres' && container.runId === fixture.runId && container.dataStorage === 'tmpfs'))
    admin = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 2, connectionTimeoutMillis: 2_000, statement_timeout: 20_000 })
    const applicationName = `delivery-owner-${fixture.runId}`
    ops = new Pool({ connectionString: fixture.opsDatabaseUrl, max: 1, application_name: applicationName,
      connectionTimeoutMillis: 2_000, statement_timeout: 20_000 })
    const repository = new PostgresCustomerDeliveryRepository(ops)
    const original = await repository.get(fixture.workspaceId, deliveryId)
    assert(original?.effectiveAt)
    const auditCount = async () => Number((await admin!.query('SELECT count(*) AS count FROM workspace_operation_audit WHERE workspace_id=$1 AND resource_id=$2', [fixture.workspaceId, deliveryId])).rows[0].count)
    const initialAudits = await auditCount()
    stage = 'hold-genuine-payment-asset-lock'
    revoker = await admin.connect()
    const revokerPid = Number((await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    await revoker.query('BEGIN ISOLATION LEVEL READ COMMITTED'); transactionOpen = true
    await revoker.query("SET LOCAL lock_timeout = '3s'")
    const asset = await revoker.query("SELECT payload FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='asset' AND entity_id=$2 FOR UPDATE", [fixture.workspaceId, assetId])
    assert.equal(asset.rows[0]?.payload.scanStatus, 'clean')
    assert.equal(asset.rows[0]?.payload.scanReceiptId, scan.attachments.find((attachment: { assetId: string }) => attachment.assetId === assetId).receiptId)
    stage = 'observe-real-repository-waiting-on-asset-before-parent'
    mutation = repository.update({ workspaceId: fixture.workspaceId, id: deliveryId, expectedRevision: original.revision,
      actorId: fixture.actorSubject, patch: { projectOwner: 'Must not commit after evidence revocation' } })
      .then(() => ({ fulfilled: true }), error => ({ fulfilled: false, code: typeof error?.code === 'string' ? error.code : undefined }))
    const deadline = Date.now() + 10_000
    let waiting = false
    while (Date.now() < deadline) {
      const state = await admin.query("SELECT wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND state='active'", [applicationName])
      waiting = state.rows.some(row => row.wait_event_type === 'Lock' && row.query.includes('assert_customer_delivery_evidence_asset') && row.blockers.includes(revokerPid))
      if (waiting) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert(waiting, 'repository must be observed waiting on the locked genuine asset')
    stage = 'revoke-asset-without-parent-lock-cycle'
    // Revoke availability, not the historical scanner verdict. Preserve the
    // immutable clean receipt; this does not claim that a new scan took place.
    await revoker.query("UPDATE business_entity_snapshots SET payload=jsonb_set(payload,'{scanStatus}','\"blocked\"'::jsonb) WHERE workspace_id=$1 AND entity_type='asset' AND entity_id=$2", [fixture.workspaceId, assetId])
    const withdrawn = (await revoker.query('SELECT effective_at,revision FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2', [fixture.workspaceId, deliveryId])).rows[0]
    assert.equal(withdrawn.effective_at, null)
    assert.equal(Number(withdrawn.revision), original.revision + 1)
    await revoker.query('COMMIT'); transactionOpen = false
    const rejected = await mutation
    assert.deepEqual(rejected, { fulfilled: false, code: '23514' })
    stage = 'verify-no-resurrection-and-atomic-audit'
    const current = await repository.get(fixture.workspaceId, deliveryId)
    assert(current)
    assert.equal(current.effectiveAt, null); assert.equal(current.projectOwner, original.projectOwner)
    assert.equal(current.revision, original.revision + 1)
    assert.equal((await repository.list({ workspaceId: fixture.workspaceId })).items.find(row => row.id === deliveryId)?.effectiveAt, null)
    await assert.rejects(repository.update({ workspaceId: fixture.workspaceId, id: deliveryId, expectedRevision: current.revision,
      actorId: fixture.actorSubject, patch: { companyName: `${original.companyName} invalid retry` } }), { code: '23514' })
    assert.equal(await auditCount(), initialAudits + 1)
    const invalidation = (await admin.query("SELECT before_json,after_json,actor_id FROM workspace_operation_audit WHERE workspace_id=$1 AND resource_id=$2 AND action='customer_delivery.evidence.invalidated'", [fixture.workspaceId, deliveryId])).rows
    assert.equal(invalidation.length, 1)
    assert.equal(invalidation[0].actor_id, 'system:customer-delivery-evidence-guard')
    assert.equal(invalidation[0].before_json.revision, original.revision)
    assert.equal(invalidation[0].after_json.revision, current.revision)
    assert.equal(invalidation[0].after_json.asset_id, assetId)
    const afterSources = await fingerprint()
    assert.deepEqual(afterSources, beforeSources, 'source changed during live acceptance; rerun stable snapshot')
    Object.assign(report, { status: 'passed', stage: 'complete', deliveryId, assetId,
      originalRevision: original.revision, revokedRevision: current.revision, genuineAssetLockWaitObserved: true,
      revocationCommittedWithoutDeadlock: true, concurrentMutationSqlState: rejected.code,
      revokedCompletionReadsNull: true, ordinaryEditCannotReactivate: true, exactlyOneInvalidationAudit: true,
      sourcesAfter: afterSources })
  } catch (error) {
    Object.assign(report, { stage, errorCode: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'OWNER_RUNTIME_ASSERTION_FAILED' })
    throw new Error(`CUSTOMER_DELIVERY_OWNER_PROBE_FAILED:${stage}`)
  } finally {
    if (transactionOpen) await revoker?.query('ROLLBACK').catch(() => undefined)
    revoker?.release()
    if (mutation) await mutation
    await Promise.all([ops?.end(), admin?.end()])
    await writeFile(join(evidenceDir, 'owner-revocation-result.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
  }
}

async function main() {
  if (process.env.OPS_E2E_DELIVERY_SCAN !== 'true') throw new Error('OWNER_ACCEPTANCE_REQUIRES_REAL_SCANNER')
  const beforeSources = await fingerprint()
  let probePassed = false
  const code = await runOpsE2e(['dogfood/chatgpt-all-functions/ops-delivery-owner-acceptance.spec.js'], process.env,
    async context => {
      let collectorPassed = false
      try { collectorPassed = JSON.parse(await readFile(join(context.evidenceDir, 'scan-result.json'), 'utf8')).status === 'passed' }
      catch (error) { if ((error as { code?: unknown })?.code !== 'ENOENT') throw error }
      if (!collectorPassed) {
        await collectRejectedAttachmentDiagnostics(context)
        throw new Error('OWNER_ACCEPTANCE_SEVEN_ATTACHMENT_COLLECTOR_NOT_PASSED')
      }
      await probeInvalidation(context, beforeSources)
      const report = JSON.parse(await readFile(join(context.evidenceDir, 'owner-revocation-result.json'), 'utf8'))
      assert.equal(report.status, 'passed')
      probePassed = true
    })
  if (code === 0 && !probePassed) throw new Error('OWNER_ACCEPTANCE_REVOCATION_PROBE_REQUIRED')
  return code
}
main().then(code => { process.exitCode = code }, error => {
  const knownCode = error instanceof Error && (/^(?:CUSTOMER_DELIVERY_OWNER_|OWNER_ACCEPTANCE_)/u.test(error.message)
    || /^(?:CUSTOMER_DELIVERY_SCAN_|OPS_E2E_|ISOLATED_FIXTURE_)[A-Z_:]+$/u.test(error.message))
  console.error(knownCode ? (error as Error).message : 'CUSTOMER_DELIVERY_OWNER_ACCEPTANCE_FAILED')
  process.exitCode = 1
})
