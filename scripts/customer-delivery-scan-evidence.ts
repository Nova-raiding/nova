import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { LocalObjectStorage } from '../packages/storage/src/object-storage.js'
import { parseAssetScanReceipt } from '../packages/security/src/asset-scan-receipt.js'
import { CUSTOMER_DELIVERY_SCAN_EVENT, parseDeliveryScanAdmission } from '../packages/workers/src/customer-delivery-scan-admission.js'
import { type IsolatedOpsFixture } from '../tests/isolated-ops-fixture.js'
import { CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS } from '../packages/persistence/src/customer-delivery-repository.js'
import { CUSTOMER_DELIVERY_CLAMAV_IMAGE, validateCustomerDeliveryScanBindings } from './customer-delivery-scan-fixture.js'

type Row = Record<string, any>
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
function requireEvidence(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`CUSTOMER_DELIVERY_SCAN_EVIDENCE_${code}`)
}
function iso(value: unknown): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(String(value))
  requireEvidence(Number.isFinite(date.valueOf()), 'TIMESTAMP_INVALID')
  return date.toISOString()
}
function confinedPath(parent: string, candidate: unknown): string {
  requireEvidence(typeof candidate === 'string' && isAbsolute(candidate), 'PATH_INVALID')
  const path = resolve(candidate), suffix = relative(parent, path)
  requireEvidence(suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix), 'PATH_OUTSIDE_RUN')
  return path
}

/** Pure binding guard; synthetic inputs in unit tests are not scan evidence. */
export function customerDeliveryScanTargets(delivery: Row, videos: Row[], items: Row[], audit: Row[]) {
  const singleton = (refs: unknown): string => {
    requireEvidence(Array.isArray(refs) && refs.length === 1 && typeof refs[0] === 'string' && refs[0].length > 0, 'ONE_REGISTERED_ATTACHMENT_PER_PURPOSE_REQUIRED')
    return refs[0]
  }
  requireEvidence(delivery.payment_status === 'paid' && delivery.payment_date != null && delivery.training_completed === true, 'PAYMENT_AND_TRAINING_NOT_REGISTERED')
  const targets = [{ purpose: 'contract', assetRef: singleton([delivery.contract_ref]), resourceId: String(delivery.id) },
    { purpose: 'payment', assetRef: singleton(delivery.payment_evidence_refs), resourceId: String(delivery.id) },
    { purpose: 'training', assetRef: singleton(delivery.training_evidence_refs), resourceId: String(delivery.id) }]
  for (const purpose of ['system_integration', 'functional_acceptance'] as const) {
    const bound = items.filter(item => item.delivery_id === delivery.id && item.checklist_key === purpose)
    const required = CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[purpose]
    requireEvidence(delivery[`${purpose}_status`] === 'complete' && bound.length === required.length
      && required.every(key => bound.filter(item => item.item_key === key && item.completed === true).length === 1), 'CHECKLIST_NOT_REGISTERED')
    const assetRef = singleton([...new Set(bound.flatMap(item => {
      singleton(item.evidence?.asset_refs)
      return item.evidence.asset_refs as string[]
    }))])
    targets.push({ purpose, assetRef, resourceId: `${delivery.id}:${purpose}` })
  }
  requireEvidence(videos.length === 2 && videos.every(video => video.delivery_id === delivery.id), 'TWO_DISTINCT_VIDEOS_REQUIRED')
  targets.push(...videos.map(video => ({ purpose: 'video', assetRef: singleton([video.asset_ref]), resourceId: String(video.id) })))
  requireEvidence(new Set(targets.map(target => target.assetRef)).size === 7, 'DISTINCT_ATTACHMENTS_REQUIRED')
  for (const target of targets) requireEvidence(audit.some(event => {
    if (!event.actor_present || event.resource_id !== target.resourceId) return false
    if (target.purpose === 'video') return event.action === 'customer_delivery.video.add' && event.video_asset_ref === target.assetRef
    if (target.purpose === 'contract') return event.action === 'customer_delivery.update' && event.contract_ref === target.assetRef
    if (target.purpose === 'payment' || target.purpose === 'training') return event.action === 'customer_delivery.update'
      && Array.isArray(event.registration?.[`${target.purpose}EvidenceRefs`]) && event.registration[`${target.purpose}EvidenceRefs`].includes(target.assetRef)
    const registered = event.registration?.items
    return event.action === 'customer_delivery.checklist_items.update' && Array.isArray(registered)
      && CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[target.purpose as 'system_integration' | 'functional_acceptance'].every(key =>
        registered.some(item => item.itemKey === key && item.completed === true && item.evidence?.asset_refs?.includes(target.assetRef)))
  }), 'REGISTRATION_AUDIT_MISSING')
  return targets
}

async function readOnly<T>(pool: Pool, workspaceId: string, role: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId])
    const state = (await client.query(`SELECT current_user AS role, current_database() AS database,
      current_setting('transaction_read_only') AS read_only, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname=current_user`)).rows[0]
    requireEvidence(state?.role === role && state.database === 'merchant' && state.read_only === 'on' && state.rolsuper === false && state.rolbypassrls === false, 'DATABASE_ROLE_UNSAFE')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release() }
}

/** Read-only post-browser gate for the real-scanner run. This does not create
 * uploads, grant points, sign receipts, acknowledge events, or repair records.
 * A complete DB chain plus genuine local-object bytes and the same run's
 * scanner readiness evidence is required; UI success alone is insufficient. */
export async function collectCustomerDeliveryScanEvidence(input: { fixture: IsolatedOpsFixture; evidenceDir: string }): Promise<void> {
  requireEvidence(isAbsolute(input.evidenceDir) && !/[\u0000-\u001f\u007f]/u.test(input.evidenceDir), 'DIRECTORY_INVALID')
  const evidenceDir = resolve(input.evidenceDir)
  let app: Pool | undefined, ops: Pool | undefined
  let stage = 'runtime-binding'
  const report: Row = { schemaVersion: 1, status: 'failed', evidenceKind: 'isolated-real-customer-delivery-scan-persistence',
    observedAt: new Date().toISOString(), sharedContainersTouched: false, businessWrites: 0, receiptSignaturesSaved: false, fileBodiesSaved: false }
  let failure: Error | undefined
  try {
    const { fixture } = input
    const runtime: Row = JSON.parse(await readFile(join(evidenceDir, 'runtime.json'), 'utf8'))
    requireEvidence(runtime.runId === fixture.runId && resolve(runtime.evidenceDir) === evidenceDir
      && runtime.persistence?.mode === 'postgres' && runtime.persistence.ready === true && runtime.redis?.ready === true
      && runtime.authorization?.mode === 'enforce' && runtime.authorization.durableAssignmentsRequired === true
      && runtime.scanner?.real === true && runtime.scanner.pointsGranted === false, 'RUNTIME_BINDING_INVALID')
    validateCustomerDeliveryScanBindings({ fixture, apiBaseUrl: `http://127.0.0.1:${runtime.apiPort}`, apiPort: runtime.apiPort })
    const appUrl = new URL(fixture.databaseUrl), opsUrl = new URL(fixture.opsDatabaseUrl)
    requireEvidence(opsUrl.protocol === appUrl.protocol && opsUrl.hostname === appUrl.hostname && opsUrl.port === appUrl.port
      && opsUrl.pathname === appUrl.pathname && opsUrl.username === 'merchant_ops' && opsUrl.password && !opsUrl.search && !opsUrl.hash, 'OPS_ENDPOINT_INVALID')
    const scannerDir = confinedPath(evidenceDir, runtime.scanner.evidenceDir)
    const scanner: Row = JSON.parse(await readFile(join(scannerDir, 'readiness.json'), 'utf8'))
    requireEvidence(scanner.runId === runtime.scanner.runId && scanner.scanner === 'real-clamav' && scanner.fixtureScanVerdictsUsed === false
      && scanner.container?.runId === scanner.runId && scanner.container.image === CUSTOMER_DELIVERY_CLAMAV_IMAGE
      && scanner.readiness?.cleanProbe === 'clean' && scanner.readiness.eicarSignature === 'Eicar-Test-Signature'
      && scanner.readiness.engineVersion && /^[0-9]+$/u.test(scanner.readiness.definitionsVersion), 'REAL_SCANNER_EVIDENCE_MISSING')
    report.runId = fixture.runId
    report.workspaceId = fixture.workspaceId
    report.scanner = { runId: scanner.runId, image: scanner.container.image, engineVersion: scanner.readiness.engineVersion,
      definitionsVersion: scanner.readiness.definitionsVersion, definitionsPublishedAt: scanner.readiness.definitionsPublishedAt,
      eicarSelfTestPassed: true, ordinaryContentProbePassed: true }
    const poolOptions = { max: 1, connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 3000,
      options: '-c default_transaction_read_only=on', application_name: 'customer-delivery-readonly-scan-evidence' }
    app = new Pool({ ...poolOptions, connectionString: fixture.databaseUrl })
    ops = new Pool({ ...poolOptions, connectionString: fixture.opsDatabaseUrl })
    stage = 'delivery-and-operation-audit'
    const control = { ...await readOnly(ops, fixture.workspaceId, 'merchant_ops', async client => ({
      deliveries: (await client.query(`SELECT id,contract_ref,revision,payment_status,payment_date,payment_evidence_refs,training_completed,training_evidence_refs,system_integration_status,functional_acceptance_status FROM workspace_customer_deliveries WHERE workspace_id=$1 ORDER BY created_at,id`, [fixture.workspaceId])).rows as Row[],
      videos: (await client.query(`SELECT id,delivery_id,asset_ref FROM workspace_customer_delivery_videos WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY sort_order,id`, [fixture.workspaceId])).rows as Row[],
      items: (await client.query(`SELECT delivery_id,checklist_key,item_key,completed,evidence FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1`, [fixture.workspaceId])).rows as Row[],
    })),
      // Ops can append delivery audit but deliberately cannot read this raw
      // tenant audit table. Use its existing RLS-bound application read role.
      audit: await readOnly(app, fixture.workspaceId, 'merchant_app', async client => (await client.query(`SELECT id,action,resource_type,resource_id,created_at,
        length(actor_id)>0 AS actor_present,after_json->>'asset_ref' AS upload_asset_ref,
        after_json->>'purpose' AS purpose,after_json->>'sha256' AS sha256,after_json->>'size_bytes' AS size_bytes,
        after_json->>'assetRef' AS video_asset_ref,after_json->>'contractRef' AS contract_ref,after_json AS registration
        FROM workspace_operation_audit WHERE workspace_id=$1 AND action LIKE 'customer_delivery.%' ORDER BY created_at,id`, [fixture.workspaceId])).rows as Row[]),
    }
    const eligible = control.deliveries.filter(delivery => typeof delivery.contract_ref === 'string'
      && control.videos.filter(video => video.delivery_id === delivery.id).length >= 2)
    requireEvidence(eligible.length === 1, 'ONE_CONTRACT_TWO_VIDEOS_NOT_REGISTERED')
    const delivery = eligible[0]!
    const videoRows = control.videos.filter(video => video.delivery_id === delivery.id)
    const targets = customerDeliveryScanTargets(delivery, videoRows, control.items, control.audit)
    const assetIds = targets.map(target => target.assetRef)
    stage = 'worker-acknowledgement'
    const pollDeadline = Date.now() + 30_000
    let rows: Row[] = []
    let pointState: Row | undefined
    do {
      const snapshot = await readOnly(app, fixture.workspaceId, 'merchant_app', async client => ({
        rows: (await client.query(`SELECT e.id AS event_id,e.workspace_id,e.aggregate_id,e.event_type,e.sequence,e.payload AS event_payload,
          e.published_at,e.unknown_at,e.lease_token IS NOT NULL AS leased,e.lease_until,e.attempts,e.last_error,
          s.entity_version,s.payload AS asset,
          a.outbox_event_id,a.asset_source_revision,a.receipt_id AS attempt_receipt_id,a.receipt_digest AS attempt_digest,
          a.canonical_receipt,a.callback_status,a.callback_attempts,a.callback_accepted_at,
          a.last_callback_error IS NOT NULL AS callback_error_present,
          COALESCE(length(a.signature) BETWEEN 40 AND 2048 AND a.signature ~ '^[A-Za-z0-9_-]+$',false) AS attempt_signature_present,
          r.receipt_id,r.receipt_digest,r.canonical_payload,r.verdict,r.object_key,r.object_sha256,
          COALESCE(length(r.signature) BETWEEN 40 AND 2048 AND r.signature ~ '^[A-Za-z0-9_-]+$',false) AS receipt_signature_present,
          a.signature=r.signature AS signatures_match,
          a.callback_body::jsonb=jsonb_build_object('receipt',r.receipt,'signature',r.signature) AS callback_body_matches
          FROM outbox_events e
          LEFT JOIN business_entity_snapshots s ON s.workspace_id=e.workspace_id AND s.entity_type='asset' AND s.entity_id=e.aggregate_id
          LEFT JOIN asset_scan_attempts a ON a.workspace_id=e.workspace_id AND a.outbox_event_id=e.id
            AND a.asset_source_revision=(e.payload->>'source_revision')::integer
          LEFT JOIN asset_scan_receipts r ON r.workspace_id=a.workspace_id AND r.receipt_id=a.receipt_id
          WHERE e.workspace_id=$1 AND e.event_type=$2 AND e.aggregate_id=ANY($3::text[])
            AND COALESCE((s.payload->>'sourceRevision')::integer,1)=(e.payload->>'source_revision')::integer
          ORDER BY e.created_at,e.id`, [fixture.workspaceId, CUSTOMER_DELIVERY_SCAN_EVENT, assetIds])).rows as Row[],
        points: (await client.query(`SELECT
          (SELECT count(*)::integer FROM creative_point_grants WHERE workspace_id=$1) AS grants,
          (SELECT COALESCE(sum(points),0)::text FROM creative_point_grants WHERE workspace_id=$1) AS granted_points,
          (SELECT count(*)::integer FROM creative_point_operations WHERE workspace_id=$1) AS operations,
          (SELECT count(*)::integer FROM creative_point_reservations WHERE workspace_id=$1) AS reservations,
          (SELECT count(*)::integer FROM creative_point_ledger_events WHERE workspace_id=$1) AS ledger_events,
          (SELECT count(*)::integer FROM creative_point_access_state WHERE workspace_id=$1) AS access_rows,
          (SELECT available_points::text FROM creative_point_access_state WHERE workspace_id=$1) AS available_points,
          (SELECT reserved_points::text FROM creative_point_access_state WHERE workspace_id=$1) AS reserved_points,
          (SELECT settled_points::text FROM creative_point_access_state WHERE workspace_id=$1) AS settled_points`, [fixture.workspaceId])).rows[0] as Row,
      }))
      rows = snapshot.rows; pointState = snapshot.points
      requireEvidence(rows.length === 7, 'SEVEN_BOUND_SCAN_EVENTS_REQUIRED')
      requireEvidence(rows.every(row => row.unknown_at == null && row.last_error?.terminal !== true), 'WORKER_TERMINAL_FAILURE')
      if (rows.every(row => row.published_at != null && row.callback_status === 'accepted' && row.callback_accepted_at != null && !row.leased && row.lease_until == null)) break
      requireEvidence(Date.now() < pollDeadline, 'WORKER_ACK_TIMEOUT')
      await new Promise(done => setTimeout(done, Math.min(250, pollDeadline - Date.now())))
    } while (true)
    requireEvidence(pointState && pointState.grants === 0 && pointState.granted_points === '0' && pointState.operations === 0
      && pointState.reservations === 0 && pointState.ledger_events === 0 && pointState.access_rows <= 1
      && [pointState.available_points, pointState.reserved_points, pointState.settled_points].every(value => value == null || value === '0'), 'POINTS_WERE_GRANTED_OR_USED')
    report.points = { grants: pointState.grants, grantedPoints: 0, operations: pointState.operations, reservations: pointState.reservations,
      ledgerEvents: pointState.ledger_events, balanceState: pointState.available_points == null ? 'uninitialized' : 'known_zero',
      availablePoints: pointState.available_points == null ? null : 0, noPointsGrantedOrConsumed: true }
    const storage = new LocalObjectStorage(join(evidenceDir, 'local-objects'))
    const checked: Row[] = []
    for (const target of targets) {
      stage = `${target.purpose}-receipt-and-object-binding`
      const matches = rows.filter(row => row.aggregate_id === target.assetRef)
      requireEvidence(matches.length === 1, 'EVENT_ASSET_AMBIGUOUS')
      const row = matches[0]!
      const admission = parseDeliveryScanAdmission({ id: row.event_id, workspaceId: row.workspace_id, aggregateId: row.aggregate_id,
        eventType: row.event_type, sequence: Number(row.sequence), payload: row.event_payload })
      requireEvidence(admission.delivery_id === delivery.id && admission.purpose === target.purpose && !row.event_payload.commercial_access_snapshot, 'ADMISSION_PURPOSE_MISMATCH')
      requireEvidence(typeof row.canonical_payload === 'string' && row.canonical_receipt === row.canonical_payload, 'CANONICAL_RECEIPTS_MISSING_OR_DIFFERENT')
      const rawReceipt = JSON.parse(row.canonical_payload)
      // Accepted immutable receipts remain evidence after their admission TTL.
      // Validate chronology at issuance; no fake wall clock is used for scans.
      const receipt = parseAssetScanReceipt(rawReceipt, { now: new Date(rawReceipt.issued_at) })
      const digest = sha(row.canonical_payload)
      requireEvidence(JSON.stringify(receipt) === row.canonical_payload && row.receipt_digest === digest && row.attempt_digest === digest
        && row.attempt_receipt_id === receipt.receipt_id && row.receipt_id === receipt.receipt_id
        && row.outbox_event_id === row.event_id && receipt.scan_job_id === row.event_id
        && row.asset_source_revision === admission.source_revision
        && receipt.scan_attempt_id === `attempt_${sha(`${row.event_id}\0${admission.source_revision}`)}`
        && receipt.receipt_id === `scan_${sha(`${row.event_id}\0${admission.source_revision}\0${admission.sha256}`)}`, 'RECEIPT_DIGEST_OR_EVENT_MISMATCH')
      const subject = receipt.subject, asset = row.asset
      const cleanKey = admission.storage_key.replace(/^quarantine\//u, 'clean/')
      requireEvidence(subject.workspace_id === fixture.workspaceId && subject.asset_id === target.assetRef
        && subject.asset_source_revision === admission.source_revision && subject.object_key === admission.storage_key
        && subject.sha256 === admission.sha256 && subject.size_bytes === admission.size_bytes && subject.mime_type === admission.mime_type
        && row.object_key === subject.object_key && row.object_sha256 === subject.sha256, 'RECEIPT_SUBJECT_MISMATCH')
      requireEvidence(asset?.id === target.assetRef && asset.workspaceId === fixture.workspaceId && asset.storageKey === cleanKey
        && asset.sha256 === admission.sha256 && asset.sizeBytes === admission.size_bytes && asset.mimeType === admission.mime_type
        && (asset.sourceRevision ?? 1) === admission.source_revision && asset.revision === Number(row.entity_version)
        && Number(row.entity_version) > admission.asset_revision
        && asset.scanStatus === 'clean' && asset.scanVerdict === 'clean' && asset.scanReceiptId === receipt.receipt_id
        && asset.scanReceiptDigest === digest && asset.scanCompletedAt === receipt.scan.completed_at, 'CLEAN_ASSET_SNAPSHOT_MISMATCH')
      requireEvidence(row.verdict === 'clean' && receipt.scan.verdict === 'clean' && receipt.scan.engine === 'clamav'
        && receipt.scan.engine_version === scanner.readiness.engineVersion && receipt.scan.definitions_version === scanner.readiness.definitionsVersion
        && receipt.issuer.scanner_service_id === `delivery-scanner-${scanner.runId}` && receipt.issuer.scanner_instance_id === `delivery-scanner-${scanner.runId}`
        && receipt.issuer.key_id === `delivery-scan-${scanner.runId}` && receipt.scan.policy_version === 'isolated-customer-delivery-real-scan-v1'
        && Date.parse(receipt.scan.started_at) >= Date.parse(scanner.readiness.observedAt), 'SCANNER_EXECUTION_MISMATCH')
      requireEvidence(row.attempt_signature_present === true && row.receipt_signature_present === true && row.signatures_match === true
        && row.callback_body_matches === true && row.callback_attempts >= 1 && row.callback_error_present === false
        && Date.parse(iso(row.published_at)!) >= Date.parse(iso(row.callback_accepted_at)!), 'SIGNED_CALLBACK_NOT_CONFIRMED')
      const uploadAudit = control.audit.filter(event => event.action === 'customer_delivery.asset.upload' && event.resource_id === delivery.id
        && event.actor_present && event.upload_asset_ref === target.assetRef && event.purpose === target.purpose
        && event.sha256 === admission.sha256 && Number(event.size_bytes) === admission.size_bytes)
      requireEvidence(uploadAudit.length > 0, 'UPLOAD_OPERATION_AUDIT_MISSING')
      const object = await storage.get(fixture.workspaceId, cleanKey)
      requireEvidence(object.metadata.workspaceId === fixture.workspaceId && object.metadata.key === cleanKey && object.metadata.zone === 'clean'
        && object.metadata.sha256 === admission.sha256 && object.metadata.sizeBytes === admission.size_bytes
        && object.metadata.contentType === admission.mime_type && object.metadata.scanEvidenceRef === `scan-receipt://${receipt.receipt_id}/${digest}`
        && object.body.byteLength === admission.size_bytes && sha(object.body) === admission.sha256, 'STORED_BYTES_OR_METADATA_MISMATCH')
      checked.push({ purpose: target.purpose, deliveryId: String(delivery.id), assetId: target.assetRef, eventId: row.event_id,
        sourceRevision: admission.source_revision, sha256: admission.sha256, sizeBytes: admission.size_bytes, mimeType: admission.mime_type,
        quarantineKeySha256: sha(admission.storage_key), cleanKeySha256: sha(cleanKey), objectBytesAndMetadataVerified: true,
        admissionDecisionId: admission.decision_id, receiptId: receipt.receipt_id, receiptDigest: digest, signaturePresentAndPersistedCopiesMatch: true,
        callbackStatus: row.callback_status, callbackAttempts: Number(row.callback_attempts), callbackAcceptedAt: iso(row.callback_accepted_at),
        workerStatus: 'completed', workerPublishedAt: iso(row.published_at), priorWorkerFailures: Number(row.attempts), uploadAuditIds: uploadAudit.map(event => String(event.id)) })
    }
    report.attachments = checked
    report.audit = control.audit.map(event => ({ id: String(event.id), action: String(event.action), resourceType: String(event.resource_type),
      resourceId: String(event.resource_id), actorPresent: event.actor_present === true, createdAt: iso(event.created_at) }))
    report.databaseRoles = { assetsAndAudit: 'merchant_app', delivery: 'merchant_ops', transactions: 'read_only', bypassRls: false }
    report.status = 'passed'
    report.signatureVerificationScope = 'Collector checks persisted signature presence and equality; the real API performed cryptographic admission. No private key or signature was exported.'
  } catch (error) {
    const code = error instanceof Error && /^CUSTOMER_DELIVERY_SCAN(?:_EVIDENCE)?_[A-Z_]+$/u.test(error.message) ? error.message : 'CUSTOMER_DELIVERY_SCAN_EVIDENCE_COLLECTION_FAILED'
    report.error = code; report.stage = stage
    const sqlState = (error as { code?: unknown })?.code
    if (typeof sqlState === 'string' && /^[0-9A-Z]{5}$/u.test(sqlState)) report.sqlState = sqlState
    failure = new Error(code)
  } finally {
    await Promise.all([app?.end(), ops?.end()])
    await writeFile(join(evidenceDir, 'scan-result.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
  }
  if (failure) throw failure
}
