import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Pool } from 'pg'
import { parseAssetScanReceipt } from '../packages/security/src/asset-scan-receipt.js'
import { CUSTOMER_DELIVERY_CLAMAV_IMAGE } from './customer-delivery-scan-fixture.js'
import type { IsolatedOpsFixture } from '../tests/isolated-ops-fixture.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function requireEvidence(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`PRODUCT_IMPORT_SCAN_EVIDENCE_${code}`)
}

/** Read-only evidence for the distinct product-import scanner path. */
export async function collectProductImportScanEvidence(input: { fixture: IsolatedOpsFixture; evidenceDir: string }): Promise<void> {
  requireEvidence(isAbsolute(input.evidenceDir), 'DIRECTORY_INVALID')
  const evidenceDir = resolve(input.evidenceDir)
  const report: Record<string, unknown> = { schemaVersion: 1, status: 'failed', evidenceKind: 'isolated-product-import-real-scan', sharedContainersTouched: false, businessWrites: 0, receiptSignaturesSaved: false }
  let failure: Error | undefined
  try {
    const runtime = JSON.parse(await readFile(join(evidenceDir, 'runtime.json'), 'utf8'))
    const browser = JSON.parse(await readFile(join(evidenceDir, 'product-import-browser-evidence.json'), 'utf8'))
    const pointFixture = JSON.parse(await readFile(join(evidenceDir, 'product-import-point-fixture.json'), 'utf8'))
    const entitlementFixture = JSON.parse(await readFile(join(evidenceDir, 'product-import-entitlement-fixture.json'), 'utf8'))
    requireEvidence(runtime.runId === input.fixture.runId && runtime.evidenceDir === evidenceDir && runtime.scanner?.real === true
      && runtime.scanner?.purpose === 'product_import' && runtime.persistence?.mode === 'postgres' && runtime.redis?.ready === true
      && browser.workspace_id === input.fixture.workspaceId && typeof browser.asset_id === 'string' && typeof browser.product_id === 'string', 'RUN_BINDING_INVALID')
    requireEvidence(pointFixture.workspaceId === input.fixture.workspaceId && pointFixture.availablePoints === 1
      && pointFixture.databaseRole === 'merchant_app' && pointFixture.bypassRls === false && pointFixture.modelCalls === 0
      && pointFixture.actor === 'isolated_fixture' && typeof pointFixture.reason === 'string', 'POINT_FIXTURE_INVALID')
    requireEvidence(entitlementFixture.workspaceId === input.fixture.workspaceId && entitlementFixture.synthetic === true
      && entitlementFixture.providerCalled === false && entitlementFixture.modelCalls === 0
      && entitlementFixture.paidAmountFen === 1 && entitlementFixture.actor === 'isolated_fixture'
      && entitlementFixture.availablePoints === 2, 'ENTITLEMENT_FIXTURE_INVALID')
    const scannerPath = resolve(runtime.scanner.evidenceDir)
    requireEvidence(scannerPath.startsWith(`${evidenceDir}/`), 'SCANNER_PATH_INVALID')
    const scanner = JSON.parse(await readFile(join(scannerPath, 'readiness.json'), 'utf8'))
    requireEvidence(scanner.runId === runtime.scanner.runId && scanner.scanner === 'real-clamav'
      && scanner.container?.image === CUSTOMER_DELIVERY_CLAMAV_IMAGE
      && scanner.readiness?.cleanProbe === 'clean' && scanner.readiness?.eicarSignature === 'Eicar-Test-Signature'
      && /^[0-9]+$/u.test(scanner.readiness?.definitionsVersion ?? ''), 'REAL_SCANNER_EVIDENCE_MISSING')
    const pool = new Pool({ connectionString: input.fixture.databaseUrl, max: 1, connectionTimeoutMillis: 2000,
      statement_timeout: 3000, query_timeout: 4000, options: '-c default_transaction_read_only=on', application_name: 'product-import-readonly-scan-evidence' })
    try {
      const client = await pool.connect()
      try {
        await client.query('BEGIN READ ONLY')
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [input.fixture.workspaceId])
        const role = (await client.query(`SELECT current_user AS role,current_setting('transaction_read_only') AS read_only,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0]
        requireEvidence(role?.role === 'merchant_app' && role.read_only === 'on' && role.rolsuper === false && role.rolbypassrls === false, 'DATABASE_ROLE_UNSAFE')
        const grants = (await client.query(`SELECT id,points,source_type,source_id,metadata FROM creative_point_grants WHERE workspace_id=$1`, [input.fixture.workspaceId])).rows
        const pointGrant = grants.find(item => item.id === pointFixture.grantId)
        requireEvidence(grants.length === 2 && pointGrant && Number(pointGrant.points) === 1
          && pointGrant.source_type === 'test_fixture' && pointGrant.source_id === input.fixture.runId
          && pointGrant.metadata?.actor === pointFixture.actor && pointGrant.metadata?.reason === pointFixture.reason, 'POINT_GRANT_NOT_DURABLE')
        const entitlement = (await client.query(`SELECT o.id,o.status,o.amount_fen,p.provider,p.verified,
          s.period_start,s.period_end,e.executable,e.resolved_benefits
          FROM commercial_orders_v2 o
          JOIN commercial_payment_events_v2 p ON p.workspace_id=o.workspace_id AND p.order_id=o.id
          JOIN workspace_subscription_periods_v2 s ON s.workspace_id=o.workspace_id AND s.order_snapshot_id IN
            (SELECT id FROM commercial_order_snapshots_v2 WHERE workspace_id=o.workspace_id AND order_id=o.id)
          JOIN workspace_entitlement_snapshots_v2 e ON e.workspace_id=s.workspace_id AND e.subscription_period_id=s.id
          WHERE o.workspace_id=$1 AND o.id=$2`, [input.fixture.workspaceId, entitlementFixture.orderId])).rows
        requireEvidence(entitlement.length === 1 && entitlement[0].status === 'paid'
          && Number(entitlement[0].amount_fen) === entitlementFixture.paidAmountFen
          && entitlement[0].provider === 'synthetic_fixture' && entitlement[0].verified === true
          && entitlement[0].executable === true && entitlement[0].resolved_benefits.some((item: { code?: string }) => item.code === 'max_brands')
          && entitlement[0].resolved_benefits.some((item: { code?: string }) => item.code === 'max_stores'), 'ENTITLEMENT_NOT_DURABLE')
        const receiptRows = (await client.query(`SELECT r.receipt_id,r.receipt_digest,r.canonical_payload,r.verdict,r.object_key,r.object_sha256,
          length(r.signature) BETWEEN 40 AND 2048 AS signature_present,
          a.outbox_event_id,a.canonical_receipt,a.receipt_digest AS attempt_digest,a.callback_status,a.callback_attempts,a.callback_accepted_at,
          a.signature=r.signature AS signatures_match,a.callback_body::jsonb=jsonb_build_object('receipt',r.receipt,'signature',r.signature) AS callback_matches,
          e.event_type,e.published_at,s.payload AS asset
          FROM asset_scan_receipts r
          JOIN asset_scan_attempts a ON a.workspace_id=r.workspace_id AND a.receipt_id=r.receipt_id
          JOIN outbox_events e ON e.workspace_id=a.workspace_id AND e.id=a.outbox_event_id
          JOIN business_entity_snapshots s ON s.workspace_id=r.workspace_id AND s.entity_type='asset' AND s.entity_id=r.asset_id
          WHERE r.workspace_id=$1 AND r.asset_id=$2`, [input.fixture.workspaceId, browser.asset_id])).rows
        requireEvidence(receiptRows.length === 1, 'ONE_SIGNED_RECEIPT_REQUIRED')
        const row = receiptRows[0]
        const receipt = parseAssetScanReceipt(JSON.parse(row.canonical_payload), { now: new Date(JSON.parse(row.canonical_payload).issued_at) })
        requireEvidence(digest(row.canonical_payload) === row.receipt_digest && row.canonical_payload === row.canonical_receipt
          && row.attempt_digest === row.receipt_digest && row.signature_present === true && row.signatures_match === true
          && row.callback_matches === true && row.callback_status === 'accepted' && Number(row.callback_attempts) >= 1
          && row.callback_accepted_at && row.published_at && row.event_type === 'asset.uploaded'
          && receipt.receipt_id === row.receipt_id && receipt.scan.verdict === 'clean' && row.verdict === 'clean'
          && receipt.scan.engine === 'clamav' && receipt.scan.engine_version === scanner.readiness.engineVersion
          && receipt.scan.definitions_version === scanner.readiness.definitionsVersion
          && receipt.scan_job_id === row.outbox_event_id && receipt.subject.asset_id === browser.asset_id
          && receipt.subject.workspace_id === input.fixture.workspaceId && receipt.subject.object_key === row.object_key
          && receipt.subject.sha256 === row.object_sha256 && row.asset?.scanStatus === 'clean'
          && row.asset?.scanReceiptId === row.receipt_id && row.asset?.scanReceiptDigest === row.receipt_digest, 'SIGNED_SCAN_CHAIN_INVALID')
        const products = (await client.query(`SELECT payload FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='product' AND entity_id=$2`, [input.fixture.workspaceId, browser.product_id])).rows
        requireEvidence(products.length === 1 && products[0].payload?.accountId == null && products[0].payload?.title?.includes('贵人鸟'), 'DRAFT_PRODUCT_MISSING')
        const knowledge = (await client.query(`SELECT id,approval_status,rights_status,index_state FROM knowledge_documents WHERE workspace_id=$1 AND product_id=$2 ORDER BY id`, [input.fixture.workspaceId, browser.product_id])).rows
        requireEvidence(knowledge.length > 0 && knowledge.every(item => item.approval_status === 'pending' && item.rights_status === 'unknown' && item.index_state === 'queued'), 'KNOWLEDGE_NOT_PENDING')
        await client.query('COMMIT')
        report.status = 'passed'
        report.assetId = browser.asset_id
        report.productId = browser.product_id
        report.knowledgeDocumentCount = knowledge.length
        report.scanner = { image: scanner.container.image, engineVersion: scanner.readiness.engineVersion,
          definitionsVersion: scanner.readiness.definitionsVersion, cleanProbe: true, eicarProbe: true }
        report.receipt = { id: row.receipt_id, digest: row.receipt_digest, signaturePresent: true, callbackAccepted: true, workerPublished: true }
        report.catalogSearch = browser.catalog_search
        report.pointFixture = { grantId: pointFixture.grantId, balanceAtGrant: 1, actor: pointFixture.actor,
          reason: pointFixture.reason, databaseRole: 'merchant_app', bypassRls: false, modelCalls: 0 }
        report.entitlementFixture = { orderId: entitlementFixture.orderId, synthetic: true, amountFen: 1,
          providerCalled: false, period: entitlementFixture.period, durableSnapshot: true }
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release() }
    } finally { await pool.end() }
  } catch (error) {
    const code = error instanceof Error && /^PRODUCT_IMPORT_SCAN_EVIDENCE_[A-Z_]+$/u.test(error.message) ? error.message : 'PRODUCT_IMPORT_SCAN_EVIDENCE_COLLECTION_FAILED'
    report.error = code
    failure = new Error(code)
  } finally {
    await writeFile(join(evidenceDir, 'product-import-scan-result.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
  }
  if (failure) throw failure
}
