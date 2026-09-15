/** Owner-run real desktop/OIDC/API/PG/ClamAV acceptance. Importing is inert.
 * node --import tsx scripts/verify-customer-delivery-contract-link.ts
 * Only fresh runner-owned tmpfs fixtures. Never reads .env, seeds receipts,
 * changes scan gates, calls a model/payment provider, or touches StoryForge.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { downloadCustomerDeliveryContract } from '../apps/api/src/customer-delivery-contract-download.js'
import { LocalObjectStorage } from '../packages/storage/src/object-storage.js'
import { CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS } from '../packages/persistence/src/customer-delivery-repository.js'
import { runOpsE2e, type OpsE2eContext } from './run-ops-oidc-e2e.js'

const scriptFile = fileURLToPath(import.meta.url), projectRoot = resolve(dirname(scriptFile), '..')
const publicPdf = { url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', sha256: '3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4', sizeBytes: 13264 }
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const sourceFiles = [
  'apps/api/openapi.yaml', 'apps/api/src/server.ts', 'apps/api/src/customer-delivery-contract-download.ts',
  'apps/api/src/customer-delivery-contract-download.test.ts', 'apps/api/src/customer-delivery-contract-link.e2e.test.ts',
  'apps/api/src/customer-delivery-upload.ts', 'apps/api/src/customer-delivery-profile-validation.ts', 'apps/api/src/asset-upload-security.ts',
  'apps/ops-console/src/api/client.ts', 'apps/ops-console/src/api/opsClient.ts', 'apps/ops-console/src/api/customerDeliveryClient.ts',
  'apps/ops-console/src/api/customerDeliveryClient.test.ts', 'apps/ops-console/src/pages/CustomerDeliveryPage.tsx',
  'apps/ops-console/src/components/delivery/CustomerDeliverySection.tsx', 'apps/ops-console/src/components/delivery/CustomerDeliveryUpload.tsx',
  'apps/ops-console/src/components/delivery/CustomerDeliveryUpload.test.tsx', 'apps/ops-console/src/components/delivery/deliveryDateTime.ts',
  'apps/worker/src/main.ts', 'apps/worker/src/clamav-scanner.ts', 'apps/worker/src/scanner-heartbeat.ts',
  'packages/workers/src/customer-delivery-scan-admission.ts', 'packages/contracts/src/authz.ts', 'packages/contracts/src/mcp.ts',
  'packages/contracts/src/customer-delivery-upload-contract.test.ts', 'packages/contracts/src/commercial-operation-registry.ts',
  'packages/security/src/asset-scan-receipt.ts', 'packages/security/src/request-security.ts', 'packages/security/src/oidc-login-proof.ts',
  'packages/persistence/src/migration.ts', 'packages/persistence/src/customer-delivery-repository.ts', 'packages/persistence/src/business-repository.ts',
  'packages/persistence/src/asset-scan-repository.ts', 'packages/persistence/src/asset-scan-attempt-repository.ts', 'packages/storage/src/object-storage.ts',
  'infra/local/ensure-app-role.sql', 'release-metadata.json', 'tests/isolated-ops-fixture.ts', 'tests/local-oidc-gateway.ts',
  'scripts/run-ops-oidc-e2e.ts', 'scripts/ops-e2e-child-monitor.ts', 'scripts/customer-delivery-scan-fixture.ts', 'scripts/customer-delivery-scan-evidence.ts',
  'dogfood/chatgpt-all-functions/ops-auth.js', 'dogfood/chatgpt-all-functions/ops-delivery-contract-link.spec.js', 'scripts/verify-customer-delivery-contract-link.ts',
]
export async function contractLinkSourceFingerprint() {
  const directory = 'packages/persistence/src/migrations'
  const migrations = (await readdir(join(projectRoot, directory))).filter(file => file.endsWith('.sql')).map(file => `${directory}/${file}`)
  return Object.fromEntries(await Promise.all([...sourceFiles, ...migrations].sort().map(async file => [file, sha(await readFile(join(projectRoot, file)))])))
}
type Json = Record<string, any>
function requireEvidence(value: unknown, suffix: string): asserts value { if (!value) throw new Error(`CONTRACT_LINK_${suffix}`) }
const safeError = (error: unknown) => error instanceof Error && /^(?:CONTRACT_LINK_|OPS_E2E_|ISOLATED_FIXTURE_|CUSTOMER_DELIVERY_)[A-Z_]+$/u.test(error.message) ? error.message : 'CONTRACT_LINK_RUNTIME_ASSERTION_FAILED'
function confined(parent: string, path: string) {
  const suffix = relative(parent, path)
  requireEvidence(isAbsolute(path) && suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix), 'EVIDENCE_PATH_OUTSIDE_RUN')
  return path
}
async function readOnly<T>(pool: Pool, workspaceId: string, role: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY'); await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId])
    const row = (await client.query("SELECT current_user AS role,current_database() AS db,current_setting('transaction_read_only') AS readonly,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0]
    requireEvidence(row?.role === role && row.db === 'merchant' && row.readonly === 'on' && row.rolsuper === false && row.rolbypassrls === false, 'READONLY_ROLE_REQUIRED')
    const result = await work(client); await client.query('COMMIT'); return result
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release() }
}

async function verifyPersistence(context: OpsE2eContext) {
  const { fixture, evidenceDir } = context
  const browser: Json = JSON.parse(await readFile(join(evidenceDir, 'contract-link/browser-result.json'), 'utf8'))
  const scan: Json = JSON.parse(await readFile(join(evidenceDir, 'scan-result.json'), 'utf8'))
  requireEvidence(browser.status === 'passed' && browser.workspaceId === fixture.workspaceId && browser.syntheticPaymentIsNotProviderEvidence === true
    && browser.rejectedRawUrlWithoutMutation === true && browser.blockedLoopbackWithoutMutation === true
    && browser.browserMocks === false && browser.modelOrPaymentProviderCalls === false
    && browser.syntheticChecklistsAreNotLiveIntegrationEvidence === true && browser.realCustomerAccountOrCommercialSuccessClaimed === false, 'BROWSER_EVIDENCE_INCOMPLETE')
  assert.deepEqual(browser.publicPdf, publicPdf)
  requireEvidence(scan.status === 'passed' && scan.runId === fixture.runId && scan.attachments?.length === 7, 'SEVEN_ATTACHMENT_COLLECTOR_REQUIRED')
  const contract = scan.attachments.find((asset: Json) => asset.purpose === 'contract')
  requireEvidence(contract?.assetId === browser.contract.assetRef && contract.deliveryId === browser.deliveryId && contract.sha256 === publicPdf.sha256
    && contract.sizeBytes === publicPdf.sizeBytes && contract.mimeType === 'application/pdf' && contract.objectBytesAndMetadataVerified === true, 'DOWNLOADED_CONTRACT_BYTES_MISMATCH')
  for (const video of browser.videos) requireEvidence(scan.attachments.some((asset: Json) => asset.purpose === 'video' && asset.assetId === video.assetRef
    && asset.sha256 === video.sha256 && asset.sizeBytes === video.sizeBytes), 'VIDEO_COLLECTOR_MISMATCH')
  requireEvidence(browser.checklists?.length === 2 && browser.videos?.length === 2, 'FIXTURE_ATTACHMENTS_INCOMPLETE')
  for (const purpose of ['system_integration', 'functional_acceptance'] as const) {
    const matching = browser.checklists.filter((asset: Json) => asset.purpose === purpose)
    requireEvidence(matching.length === 1 && matching[0].syntheticOnly === true && matching[0].allPersisted === true, 'CHECKLIST_FIXTURE_MISSING')
    assert.deepEqual(matching[0].itemKeys, CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[purpose])
    requireEvidence(matching[0].itemCount === CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[purpose].length, 'CHECKLIST_ITEM_COUNT_MISMATCH')
  }
  for (const proof of [browser.payment, browser.training, ...browser.checklists]) requireEvidence(scan.attachments.some((asset: Json) => asset.purpose === proof.purpose
    && asset.assetId === proof.assetRef && asset.deliveryId === browser.deliveryId && asset.sha256 === proof.sha256 && asset.sizeBytes === proof.sizeBytes
    && asset.objectBytesAndMetadataVerified === true), 'SYNTHETIC_ATTACHMENT_COLLECTOR_MISMATCH')
  requireEvidence(new Set(scan.attachments.map((asset: Json) => asset.assetId)).size === 7 && new Set(scan.attachments.map((asset: Json) => asset.sha256)).size === 7, 'SEVEN_DISTINCT_ATTACHMENTS_REQUIRED')
  const visual = []
  for (const file of ['contract-pending.png', 'contract-clean.png', 'contract-saved.png', 'contract-reread.png', 'contract-import.webm']) {
    const path = join(evidenceDir, 'contract-link', file), bytes = await readFile(path)
    requireEvidence((await stat(path)).size > 0 && browser.visualEvidence.includes(file), 'VISUAL_EVIDENCE_MISSING')
    visual.push({ file: `contract-link/${file}`, sha256: sha(bytes), sizeBytes: bytes.length })
  }
  const options = { max: 1, connectionTimeoutMillis: 2000, statement_timeout: 5000, query_timeout: 6000, options: '-c default_transaction_read_only=on', application_name: 'contract-link-readonly-evidence' }
  const app = new Pool({ ...options, connectionString: fixture.databaseUrl }), ops = new Pool({ ...options, connectionString: fixture.opsDatabaseUrl })
  try {
    const delivery = await readOnly(ops, fixture.workspaceId, 'merchant_ops', async client => (await client.query(`SELECT id,contract_ref,contract_number,payment_status,payment_date,payment_evidence_refs,customer_profile_status,system_integration_status,functional_acceptance_status,training_completed,training_evidence_refs,revision,effective_at
      FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2`, [fixture.workspaceId, browser.deliveryId])).rows[0])
    requireEvidence(delivery?.contract_ref === contract.assetId && delivery.contract_number === 'FIXTURE-PUBLIC-CONTRACT' && delivery.customer_profile_status === 'complete'
      && delivery.payment_status === 'paid' && delivery.payment_evidence_refs?.length === 1 && delivery.payment_evidence_refs[0] === browser.payment.assetRef
      && delivery.system_integration_status === 'complete' && delivery.functional_acceptance_status === 'complete' && delivery.training_completed === true
      && delivery.training_evidence_refs?.length === 1 && delivery.training_evidence_refs[0] === browser.training.assetRef
      && Number(delivery.revision) === browser.finalRevision && delivery.effective_at != null
      && new Date(delivery.effective_at).toISOString() === browser.fixtureEffectiveAt, 'PERSISTED_PROFILE_MISMATCH')
    const checklistRows = await readOnly(ops, fixture.workspaceId, 'merchant_ops', async client => (await client.query(`SELECT checklist_key,item_key,completed,evidence
      FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id=$2`, [fixture.workspaceId, browser.deliveryId])).rows)
    requireEvidence(checklistRows.length === 18, 'EIGHTEEN_CHECKLIST_ITEMS_REQUIRED')
    for (const proof of browser.checklists) {
      const rows = checklistRows.filter(row => row.checklist_key === proof.purpose)
      assert.deepEqual(rows.map(row => row.item_key).sort(), [...proof.itemKeys].sort())
      requireEvidence(rows.every(row => row.completed === true && row.evidence?.asset_refs?.length === 1 && row.evidence.asset_refs[0] === proof.assetRef
        && row.evidence.note === 'SYNTHETIC FIXTURE ONLY: no real account, shop, points or model execution verified'), 'CHECKLIST_BINDING_MISMATCH')
    }
    const audit = await readOnly(app, fixture.workspaceId, 'merchant_app', async client => (await client.query(`SELECT id,action,actor_id=$3 AS actor_matches,
      after_json->>'asset_ref' AS asset_ref,after_json->>'purpose' AS purpose,after_json->>'source_kind' AS source_kind,
      after_json->>'sha256' AS sha256,after_json->>'size_bytes' AS size_bytes,after_json->>'scan_status' AS scan_status
      FROM workspace_operation_audit WHERE workspace_id=$1 AND resource_id=$2 AND action='customer_delivery.asset.upload' ORDER BY created_at,id`, [fixture.workspaceId, browser.deliveryId, fixture.actorSubject])).rows)
    requireEvidence(audit.length === 7 && audit.every(row => row.actor_matches), 'SEVEN_UPLOAD_AUDITS_REQUIRED')
    const contractAudits = audit.filter(row => row.asset_ref === contract.assetId)
    requireEvidence(contractAudits.length === 1 && contractAudits[0].purpose === 'contract' && contractAudits[0].source_kind === 'https_download'
      && contractAudits[0].scan_status === 'pending' && contractAudits[0].sha256 === publicPdf.sha256 && Number(contractAudits[0].size_bytes) === publicPdf.sizeBytes, 'CONTRACT_DOWNLOAD_PENDING_AUDIT_MISSING')
    // Extra payment is an explicitly synthetic prerequisite, never a provider
    // receipt. Nevertheless its asset MUST have genuine accepted ClamAV proof.
    const paymentRows = await readOnly(app, fixture.workspaceId, 'merchant_app', async client => (await client.query(`SELECT s.payload AS asset,
      public.asset_snapshot_is_trusted_clean(s.workspace_id,s.entity_id,s.payload) AS trusted,
      e.id AS event_id,e.payload AS admission,e.published_at,e.unknown_at,e.lease_token IS NULL AS unleased,
      a.callback_status,a.callback_accepted_at,a.receipt_digest AS attempt_digest,a.canonical_receipt,
      a.signature=r.signature AS signatures_match,a.callback_body::jsonb=jsonb_build_object('receipt',r.receipt,'signature',r.signature) AS callback_body_matches,
      r.receipt_id,r.receipt_digest,r.canonical_payload,r.receipt,r.verdict
      FROM business_entity_snapshots s
      JOIN outbox_events e ON e.workspace_id=s.workspace_id AND e.aggregate_id=s.entity_id AND e.event_type='asset.customer_delivery_quarantined'
      JOIN asset_scan_attempts a ON a.workspace_id=e.workspace_id AND a.outbox_event_id=e.id AND a.asset_source_revision=(e.payload->>'source_revision')::integer
      JOIN asset_scan_receipts r ON r.workspace_id=a.workspace_id AND r.receipt_id=a.receipt_id
      WHERE s.workspace_id=$1 AND s.entity_type='asset' AND s.entity_id=$2`, [fixture.workspaceId, browser.payment.assetRef])).rows)
    requireEvidence(paymentRows.length === 1, 'PAYMENT_SCAN_CHAIN_AMBIGUOUS')
    const payment = paymentRows[0]!, asset = payment.asset, receipt = payment.receipt
    requireEvidence(payment.trusted === true && asset.scanStatus === 'clean' && asset.sha256 === browser.payment.sha256 && asset.sizeBytes === browser.payment.sizeBytes
      && payment.admission.delivery_scan_admission?.delivery_id === browser.deliveryId && payment.admission.delivery_scan_admission?.purpose === 'payment'
      && payment.published_at && payment.unknown_at == null && payment.unleased && payment.callback_status === 'accepted' && payment.callback_accepted_at
      && payment.signatures_match === true && payment.callback_body_matches === true && payment.verdict === 'clean'
      && payment.receipt_digest === sha(payment.canonical_payload) && payment.attempt_digest === payment.receipt_digest && payment.canonical_receipt === payment.canonical_payload
      && receipt.scan.engine === 'clamav' && receipt.scan.verdict === 'clean' && receipt.scan.engine_version === scan.scanner.engineVersion
      && receipt.scan.definitions_version === scan.scanner.definitionsVersion && receipt.issuer.scanner_service_id === `delivery-scanner-${scan.scanner.runId}`
      && receipt.subject.asset_id === browser.payment.assetRef && receipt.subject.workspace_id === fixture.workspaceId && receipt.subject.sha256 === browser.payment.sha256
      && receipt.scan_job_id === payment.event_id && asset.scanReceiptId === payment.receipt_id && asset.scanReceiptDigest === payment.receipt_digest, 'GENUINE_PAYMENT_SCAN_REQUIRED')
    const storage = new LocalObjectStorage(join(evidenceDir, 'local-objects'))
    const object = await storage.get(fixture.workspaceId, asset.storageKey)
    requireEvidence(object.metadata.zone === 'clean' && object.metadata.sha256 === browser.payment.sha256 && sha(object.body) === browser.payment.sha256
      && object.body.length === browser.payment.sizeBytes && object.metadata.scanEvidenceRef === `scan-receipt://${payment.receipt_id}/${payment.receipt_digest}`, 'PAYMENT_BYTES_MISMATCH')
    return { status: 'passed', fixtureRunId: fixture.runId, workspaceId: fixture.workspaceId, deliveryId: browser.deliveryId, contract,
      uploadAudit: audit.map(row => ({ id: row.id, assetRef: row.asset_ref, purpose: row.purpose, sourceKind: row.source_kind, pending: row.scan_status === 'pending', actorMatches: row.actor_matches })),
      payment: { fixtureOnly: true, notProviderPaymentEvidence: true, assetRef: browser.payment.assetRef, sha256: browser.payment.sha256, receiptId: payment.receipt_id, receiptDigest: payment.receipt_digest, genuineClamAvAndBytesVerified: true },
      fixtureCompletion: { effectiveAt: browser.fixtureEffectiveAt, checklistItems: checklistRows.length, syntheticOnly: true },
      visual, completeRealCustomerDeliveryClaimed: false, realAccountOrCommercialSuccessClaimed: false, realPaymentClaimed: false, rawReceiptsOrCredentialsSaved: false, databaseWritesByCollector: 0 }
  } finally { await Promise.all([app.end(), ops.end()]) }
}

export async function verifyCustomerDeliveryContractLink() {
  requireEvidence(resolve(process.cwd()) === projectRoot && process.argv.slice(2).length === 0, 'RUN_FROM_ROOT_WITHOUT_OVERRIDES')
  const startedAt = new Date().toISOString(), before = await contractLinkSourceFingerprint()
  const root = join(projectRoot, 'artifacts/customer-delivery-contract-link'); await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(root, 'run-'))
  const report: Json = { status: 'failed', startedAt, sourcesBefore: before, scope: 'contract URL import only; not all customer delivery requirements', sharedContainersTouched: false, providersCalled: false }
  let stage = 'strict-public-pdf-preflight', context: OpsE2eContext | undefined
  console.log(`Contract-link owner evidence: ${directory}`)
  try {
    // Production downloader used before any heavy fixture. No proxy/TLS/SSRF
    // relaxations, uploads, local copies, or alternate URL on network failure.
    const downloaded = await downloadCustomerDeliveryContract(publicPdf.url)
    requireEvidence(downloaded.sha256 === publicPdf.sha256 && downloaded.mime_type === 'application/pdf'
      && Buffer.from(downloaded.content_base64, 'base64').length === publicPdf.sizeBytes, 'PUBLIC_SAMPLE_CHANGED')
    report.publicSample = { ...publicPdf, observedAt: new Date().toISOString(), productionDownloaderUsed: true }
    stage = 'isolated-real-browser-and-scanner'
    const code = await runOpsE2e(['dogfood/chatgpt-all-functions/ops-delivery-contract-link.spec.js'], { ...process.env, OPS_E2E_DELIVERY_SCAN: 'true', OPS_E2E_BROWSER_TIMEOUT_MS: '600000' }, async current => {
      context = current; report.fixtureEvidenceDir = current.evidenceDir
      assert.deepEqual(await contractLinkSourceFingerprint(), before, 'CONTRACT_LINK_SOURCE_CHANGED')
      report.persistence = await verifyPersistence(current)
    })
    requireEvidence(code === 0 && context && report.persistence?.status === 'passed', 'RUNNER_OR_PERSISTENCE_FAILED')
    stage = 'exact-owned-container-cleanup'
    const disposal: Json = JSON.parse(await readFile(join(context.evidenceDir, `fixture-disposal-${context.fixture.runId}.json`), 'utf8'))
    requireEvidence(disposal.runId === context.fixture.runId && disposal.leftRunning.length === 0 && disposal.externalContainersTouched === false, 'FIXTURE_CLEANUP_FAILED')
    assert.deepEqual([...disposal.stopped].sort(), context.fixture.containerEvidence.map(container => container.id).sort())
    const runtime: Json = JSON.parse(await readFile(join(context.evidenceDir, 'runtime.json'), 'utf8'))
    const scannerDir = confined(context.evidenceDir, runtime.scanner.evidenceDir)
    const scanDisposal: Json = JSON.parse(await readFile(join(scannerDir, 'disposal.json'), 'utf8'))
    const readiness: Json = JSON.parse(await readFile(join(scannerDir, 'readiness.json'), 'utf8'))
    requireEvidence(scanDisposal.runId === runtime.scanner.runId && scanDisposal.leftRunning.length === 0 && scanDisposal.sharedContainersTouched === false, 'SCANNER_CLEANUP_FAILED')
    assert.deepEqual(scanDisposal.stopped, [readiness.container.id])
    report.cleanup = { fixture: disposal, scanner: scanDisposal }
    stage = 'final-source-fingerprint'; assert.deepEqual(await contractLinkSourceFingerprint(), before, 'CONTRACT_LINK_SOURCE_CHANGED')
    report.status = 'passed'; stage = 'complete'; return 0
  } catch (error) { report.errorCode = safeError(error); throw new Error(report.errorCode) }
  finally {
    report.finishedAt = new Date().toISOString(); report.stage = stage; report.sourcesAfter = await contractLinkSourceFingerprint()
    report.sourcesUnchanged = JSON.stringify(report.sourcesAfter) === JSON.stringify(before)
    if (!report.sourcesUnchanged) { report.status = 'failed'; report.errorCode = 'CONTRACT_LINK_SOURCE_CHANGED' }
    await writeFile(join(directory, 'run-result.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
    if (!report.sourcesUnchanged) throw new Error('CONTRACT_LINK_SOURCE_CHANGED')
  }
}
if (process.argv[1] && resolve(process.argv[1]) === scriptFile) verifyCustomerDeliveryContractLink().then(code => { process.exitCode = code }, error => { console.error(safeError(error)); process.exitCode = 1 })
