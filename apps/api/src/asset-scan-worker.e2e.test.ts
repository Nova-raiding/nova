import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASSET_SCAN_RECEIPT_SCHEMA, parseAssetScanReceipt, signAssetScanReceipt } from '../../../packages/security/src/asset-scan-receipt.js'
import { assetContinuationReadyEventsForTests, assetScanJobIdForTests, server, service, workspaceMembers } from './server.js'

type Envelope<T> = { data: T; error: { code: string } | null }

const workspaceId = 'ws_scanner_e2e'
const scannerToken = 'scanner-e2e-token'
const scannerSecret = 'scanner-e2e-signing-secret'
const workerToken = 'worker-continuation-e2e-token'
const workerSecret = 'worker-continuation-e2e-signing-secret'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
let base = ''
let storageRoot = ''

function scannerHeaders(method: string, path: string, requestBody = '', options: { timestamp?: string; nonce?: string; bodyDigest?: string } = {}) {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000))
  const nonce = options.nonce ?? randomBytes(18).toString('base64url')
  const bodyDigest = options.bodyDigest ?? createHash('sha256').update(requestBody).digest('hex')
  const signature = createHmac('sha256', scannerSecret).update([method, path, workspaceId, timestamp, nonce, bodyDigest].join('\n')).digest('hex')
  return {
    authorization: `Bearer ${scannerToken}`,
    'x-workspace-id': workspaceId,
    'x-scanner-timestamp': timestamp,
    'x-scanner-nonce': nonce,
    'x-scanner-body-sha256': bodyDigest,
    'x-scanner-workspace-signature': signature,
  }
}

function workerHeaders(method: string, path: string) {
  const signature = createHmac('sha256', workerSecret).update(`${method}\n${path}\n${workspaceId}`).digest('hex')
  return { authorization: `Bearer ${workerToken}`, 'x-workspace-id': workspaceId, 'x-worker-workspace-signature': signature }
}

async function upload(name: string) {
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(name)])
  const response = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'x-workspace-id': workspaceId, 'content-type': 'image/png', 'x-asset-name': name }, body: bytes })
  const envelope = await response.json() as Envelope<{ id: string; storageKey: string; sha256: string; sizeBytes: number; sourceRevision?: number; scanStatus: string }>
  expect(envelope.error).toBeNull()
  expect(envelope.data.scanStatus).toBe('quarantined')
  return envelope.data
}

function signedReceipt(asset: Awaited<ReturnType<typeof upload>>, verdict: 'clean' | 'malicious', overrides: { scanJobId?: string; scannerServiceId?: string; engine?: string; definitionsVersion?: string; policyVersion?: string } = {}) {
  const now = new Date()
  const receipt = parseAssetScanReceipt({
    schema_version: ASSET_SCAN_RECEIPT_SCHEMA,
    receipt_id: `receipt_${asset.id}_${verdict}`,
    scan_job_id: overrides.scanJobId ?? assetScanJobIdForTests(workspaceId, asset.id),
    scan_attempt_id: `attempt_${asset.id}`,
    issuer: { scanner_service_id: overrides.scannerServiceId ?? 'scanner-e2e', scanner_instance_id: 'scanner-e2e-1', key_id: 'scanner-e2e-key' },
    subject: { workspace_id: workspaceId, asset_id: asset.id, asset_source_revision: asset.sourceRevision ?? 1, object_key: asset.storageKey, sha256: asset.sha256, size_bytes: asset.sizeBytes, mime_type: 'image/png' },
    scan: { verdict, engine: overrides.engine ?? 'clamav', engine_version: '1.5.3', definitions_version: overrides.definitionsVersion ?? '27804', policy_version: overrides.policyVersion ?? 'test-policy', started_at: now.toISOString(), completed_at: now.toISOString(), findings: verdict === 'clean' ? [] : ['Eicar-Signature'] },
    issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 60_000).toISOString(),
  })
  return { receipt, signature: signAssetScanReceipt(receipt, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()) }
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'merchant-scanner-e2e-'))
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('ASSET_STORAGE_ROOT', storageRoot)
  vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'false')
  vi.stubEnv('ASSET_SCANNER_API_TOKEN', scannerToken)
  vi.stubEnv('ASSET_SCANNER_WORKSPACE_SIGNING_SECRET', scannerSecret)
  vi.stubEnv('ASSET_SCANNER_MODE', 'clamav_worker')
  vi.stubEnv('WORKER_API_TOKEN', workerToken)
  vi.stubEnv('WORKER_API_SIGNING_SECRET', workerSecret)
  vi.stubEnv('ASSET_SCAN_TRUSTED_PUBLIC_KEYS', JSON.stringify({ 'scanner-e2e-key': publicKey.export({ type: 'spki', format: 'pem' }).toString() }))
  vi.stubEnv('ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS', 'scanner-e2e')
  vi.stubEnv('ASSET_SCAN_POLICY_VERSION', 'test-policy')
  vi.stubEnv('ASSET_SCAN_MIN_DEFINITIONS_VERSION', '27800')
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
  await rm(storageRoot, { recursive: true, force: true })
})

describe('automatic platform asset scanner boundary', () => {
  it('requires scanner credentials and promotes only a correctly bound signed clean receipt', async () => {
    const asset = await upload('clean.png')
    const path = `/v1/internal/assets/${encodeURIComponent(asset.id)}/scan-content`
    expect((await fetch(`${base}${path}`, { headers: { 'x-workspace-id': workspaceId } })).status).toBe(403)
    const content = await fetch(`${base}${path}`, { headers: scannerHeaders('GET', path) })
    expect(content.status).toBe(200)
    expect(createHash('sha256').update(Buffer.from(await content.arrayBuffer())).digest('hex')).toBe(asset.sha256)

    const resultPath = `/v1/internal/assets/${encodeURIComponent(asset.id)}/scan-result`
    const resultBody = JSON.stringify(signedReceipt(asset, 'clean'))
    const result = await fetch(`${base}${resultPath}`, { method: 'POST', headers: { 'content-type': 'application/json', ...scannerHeaders('POST', resultPath, resultBody) }, body: resultBody })
    expect(result.status, await result.clone().text()).toBe(200)
    expect((await result.json() as Envelope<{ scan_status: string }>).data.scan_status).toBe('clean')
    expect((await fetch(`${base}/v1/assets/${encodeURIComponent(asset.id)}/download`, { headers: { 'x-workspace-id': workspaceId } })).status).toBe(200)
  })

  it('keeps a malicious object out of clean storage and marks it blocked', async () => {
    const asset = await upload('eicar.png')
    const path = `/v1/internal/assets/${encodeURIComponent(asset.id)}/scan-result`
    const resultBody = JSON.stringify(signedReceipt(asset, 'malicious'))
    const result = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...scannerHeaders('POST', path, resultBody) }, body: resultBody })
    expect(result.status).toBe(200)
    expect((await result.json() as Envelope<{ scan_status: string }>).data.scan_status).toBe('blocked')
    const download = await fetch(`${base}/v1/assets/${encodeURIComponent(asset.id)}/download`, { headers: { 'x-workspace-id': workspaceId } })
    expect(download.status).toBe(403)
  })

  it('presents quarantined uploads as automatic system work with no manual scan action', async () => {
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'merchant-auto-scan-ux' }
    const mcp = (id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }).then(response => response.json()) as Promise<any>
    const source = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(`automatic-scan-${Date.now()}`)])
    const uploaded = await mcp(70, 'asset.upload', { name: 'automatic-scan.png', mime_type: 'image/png', content_base64: source.toString('base64') })
    expect(uploaded.error).toBeNull()
    expect(uploaded.data.result).toMatchObject({
      scanStatus: 'quarantined',
      scanAutomation: { state: 'pending', mode: 'platform_worker', userActionRequired: false, message: '系统正在自动检查，通过后自动继续；无需操作' },
    })

    const listed = await mcp(71, 'asset.list', {})
    expect(listed.error).toBeNull()
    const action = listed.data.result.asset_actions.find((item: { asset_id: string }) => item.asset_id === uploaded.data.result.id)
    expect(action).toMatchObject({ action: null, next_step: '系统正在自动检查，通过后自动继续；无需操作', scan_automation: { userActionRequired: false } })
    expect(listed.data.result.action_cards).toEqual([])
    expect(JSON.stringify({ upload: uploaded.data.result, action })).not.toMatch(/scan_evidence_ref|提交安全扫描结果|管理员|"method":"asset\.scan"/u)
  })

  it('binds scanner HMAC to timestamp, one-time nonce, and the exact body bytes', async () => {
    const asset = await upload('scanner-proof.png')
    const contentPath = `/v1/internal/assets/${encodeURIComponent(asset.id)}/scan-content`
    const reusableHeaders = scannerHeaders('GET', contentPath)
    expect((await fetch(`${base}${contentPath}`, { headers: reusableHeaders })).status).toBe(200)
    const replay = await fetch(`${base}${contentPath}`, { headers: reusableHeaders })
    expect(replay.status).toBe(409)
    expect((await replay.json() as Envelope<null>).error?.code).toBe('ASSET_SCANNER_NONCE_REPLAY')

    const expired = await fetch(`${base}${contentPath}`, { headers: scannerHeaders('GET', contentPath, '', { timestamp: String(Math.floor(Date.now() / 1000) - 120) }) })
    expect(expired.status).toBe(403)

    const resultPath = `/v1/internal/assets/${encodeURIComponent(asset.id)}/scan-result`
    const bodyBytes = JSON.stringify(signedReceipt(asset, 'clean'))
    const tampered = await fetch(`${base}${resultPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...scannerHeaders('POST', resultPath, `${bodyBytes} `) },
      body: bodyBytes,
    })
    expect(tampered.status).toBe(403)
  })

  it('rejects unapproved scanner, engine, policy, definitions, and forged scan jobs before promotion', async () => {
    const asset = await upload('receipt-policy.png')
    const path = `/v1/internal/assets/${encodeURIComponent(asset.id)}/scan-result`
    const submit = async (receipt: ReturnType<typeof signedReceipt>) => {
      const requestBody = JSON.stringify(receipt)
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...scannerHeaders('POST', path, requestBody) }, body: requestBody })
      const envelope = await response.json() as Envelope<null>
      return { response, envelope }
    }
    expect((await submit(signedReceipt(asset, 'clean', { scannerServiceId: 'unapproved-scanner' }))).envelope.error?.code).toBe('ASSET_SCAN_RECEIPT_ISSUER_UNAPPROVED')
    expect((await submit(signedReceipt(asset, 'clean', { engine: 'not-clamav' }))).envelope.error?.code).toBe('ASSET_SCAN_RECEIPT_ENGINE_INVALID')
    expect((await submit(signedReceipt(asset, 'clean', { policyVersion: 'retired-policy' }))).envelope.error?.code).toBe('ASSET_SCAN_RECEIPT_POLICY_MISMATCH')
    expect((await submit(signedReceipt(asset, 'clean', { definitionsVersion: '27799' }))).envelope.error?.code).toBe('ASSET_SCAN_RECEIPT_DEFINITIONS_STALE')
    expect((await submit(signedReceipt(asset, 'clean', { scanJobId: 'evt_forged_scan_job' }))).envelope.error?.code).toBe('ASSET_SCAN_RECEIPT_JOB_BINDING_INVALID')
    const accepted = await submit(signedReceipt(asset, 'clean'))
    expect(accepted.response.status).toBe(200)
  })

  it('keeps the production scanner identity separate and disables MCP asset.scan', async () => {
    const asset = await upload('production-identity.png')
    const merchantToken = 'merchant-production-scan-boundary'
    const merchantActor = 'merchant-production-scan-owner'
    await workspaceMembers.upsert({ workspaceId, externalSubject: merchantActor, displayName: merchantActor, role: 'workspace_owner', status: 'active', invitedBy: 'scanner-boundary-test' })
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'scanner-boundary-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [merchantToken]: { workspaces: [workspaceId], actor_id: merchantActor, roles: ['workspace_owner'] } }))
    try {
      const contentPath = `/v1/internal/assets/${encodeURIComponent(asset.id)}/scan-content`
      const scannerContent = await fetch(`${base}${contentPath}`, { headers: scannerHeaders('GET', contentPath) })
      expect(scannerContent.status).toBe(200)

      const merchantRouteWithScannerIdentity = await fetch(`${base}/v1/assets`, { headers: { authorization: `Bearer ${scannerToken}`, 'x-workspace-id': workspaceId } })
      expect(merchantRouteWithScannerIdentity.status).toBe(403)

      const mcpBody = JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'asset.scan', params: { asset_id: asset.id, scan_evidence_ref: 'attacker-controlled-evidence' } })
      const mcpScan = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${merchantToken}`, 'x-workspace-id': workspaceId, 'content-type': 'application/json' }, body: mcpBody })
      expect(mcpScan.status).toBe(410)
      expect((await mcpScan.json() as Envelope<null>).error?.code).toBe('MCP_ASSET_SCAN_DISABLED')
      expect(service.assets.get(asset.id)?.scanStatus).toBe('quarantined')
    } finally {
      vi.stubEnv('NODE_ENV', 'test')
      vi.stubEnv('API_AUTH_TOKENS', '{}')
      vi.stubEnv('SESSION_ID_HASH_SECRET', '')
    }
  })

  it('persists the original image intent, waits only for rights after clean, and resumes exactly once', async () => {
    const product = service.importProduct({ workspaceId, platform: 'jd', localProductKey: `continuation-${Date.now()}`, title: '自动续跑测试商品', category: '家居', stock: 5, price: 99 })
    service.confirmProductFacts(workspaceId, product.id)
    const actorId = 'merchant-continuation-e2e'
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': actorId }
    const mcp = (id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }).then(response => response.json()) as Promise<any>
    const source = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from('continuation-source')])
    const beforeBilling = await mcp(1, 'billing.model-usage.statement', {})
    const uploaded = await mcp(2, 'asset.upload', {
      name: 'continuation.png', mime_type: 'image/png', content_base64: source.toString('base64'),
      rights_scope: 'commercial_authorized', applicable_platforms_json: '["jd"]', usage_scopes_json: '["commercial","ai_generation"]', ai_modification_allowed: 'true',
      continuation_kind: 'image_generation', continuation_product_id: product.id, continuation_direction: '京东白底主图，保持商品本体不变', continuation_count: '1', continuation_idempotency_key: `continuation-${product.id}`,
    })
    expect(uploaded.error).toBeNull()
    expect(uploaded.data.result).toMatchObject({ scanStatus: 'quarantined', generationContinuation: { state: 'waiting_scan', jobId: expect.any(String) } })
    const asset = uploaded.data.result as { id: string; storageKey: string; sha256: string; sizeBytes: number; sourceRevision?: number; scanStatus: string; generationContinuation: { jobId: string } }
    const jobId = asset.generationContinuation.jobId

    const scanPath = `/v1/internal/assets/${encodeURIComponent(asset.id)}/scan-result`
    const cleanBody = JSON.stringify(signedReceipt(asset, 'clean'))
    const firstScan = await fetch(`${base}${scanPath}`, { method: 'POST', headers: { 'content-type': 'application/json', ...scannerHeaders('POST', scanPath, cleanBody) }, body: cleanBody })
    expect(firstScan.status).toBe(200)
    const duplicateScan = await fetch(`${base}${scanPath}`, { method: 'POST', headers: { 'content-type': 'application/json', ...scannerHeaders('POST', scanPath, cleanBody) }, body: cleanBody })
    expect(duplicateScan.status).toBe(200)

    const waiting = await mcp(3, 'catalog.image.get', { job_id: jobId })
    expect(waiting.data.result.job).toMatchObject({ state: 'queued', continuationState: 'awaiting_rights', continuationUserActionRequired: true })
    const executePath = `/v1/internal/image-generation-continuations/${encodeURIComponent(jobId)}/execute`
    const tooEarly = await fetch(`${base}${executePath}`, { method: 'POST', headers: workerHeaders('POST', executePath) })
    expect(tooEarly.status).toBe(409)

    const rights = await mcp(4, 'asset.rights.update', { asset_id: asset.id, rights_status: 'approved', rights_scope: 'commercial_authorized', applicable_platforms_json: '["jd"]', usage_scopes_json: '["commercial","ai_generation"]', ai_modification_allowed: 'true' })
    expect(rights.error).toBeNull()
    const readyEvents = assetContinuationReadyEventsForTests(workspaceId, asset.id)
    expect(readyEvents).toHaveLength(0)
    expect(service.imageGenerationJobs.get(jobId)?.continuation?.state).toBe('awaiting_confirmation')
    const awaitingConfirmation = await mcp(4.1, 'asset.generation.confirm', { job_id: jobId })
    expect(awaitingConfirmation.error).toBeNull()
    expect(assetContinuationReadyEventsForTests(workspaceId, asset.id)).toHaveLength(1)
    expect(assetContinuationReadyEventsForTests(workspaceId, asset.id)[0]).toMatchObject({ payload: { continuation_job_ids: [jobId] } })
    const readyJobRevision = service.imageGenerationJobs.get(jobId)?.revision
    const duplicateRights = await mcp(41, 'asset.rights.update', { asset_id: asset.id, rights_status: 'approved', rights_scope: 'commercial_authorized', applicable_platforms_json: '["jd"]', usage_scopes_json: '["commercial","ai_generation"]', ai_modification_allowed: 'true' })
    expect(duplicateRights.error).toBeNull()
    expect(assetContinuationReadyEventsForTests(workspaceId, asset.id)).toHaveLength(1)
    expect(service.imageGenerationJobs.get(jobId)?.revision).toBe(readyJobRevision)
    const executions = await Promise.all([
      fetch(`${base}${executePath}`, { method: 'POST', headers: workerHeaders('POST', executePath) }),
      fetch(`${base}${executePath}`, { method: 'POST', headers: workerHeaders('POST', executePath) }),
    ])
    expect(executions.every(response => response.status === 200)).toBe(true)
    const executionBodies = await Promise.all(executions.map(response => response.json())) as Array<Envelope<{ job_id: string; state: string; continuation_state: string }>>
    expect(executionBodies.every(body => body.data.job_id === jobId && body.data.state === 'succeeded' && body.data.continuation_state === 'completed')).toBe(true)

    const replay = await fetch(`${base}${executePath}`, { method: 'POST', headers: workerHeaders('POST', executePath) })
    expect(replay.status).toBe(200)
    expect((await replay.json() as Envelope<{ already_completed: boolean }>).data.already_completed).toBe(true)
    const finalJob = await mcp(5, 'catalog.image.get', { job_id: jobId })
    expect(finalJob.data.result.job).toMatchObject({ state: 'succeeded', continuationState: 'completed', continuationUserActionRequired: false })
    expect([...service.imageGenerationJobs.values()].filter(job => job.workspaceId === workspaceId && job.idempotencyKey === `continuation-${product.id}`)).toHaveLength(1)
    const afterBilling = await mcp(6, 'billing.model-usage.statement', {})
    expect(afterBilling.data.result.action_ledger.record_count - beforeBilling.data.result.action_ledger.record_count).toBe(1)
  })

  it('does not restart a legacy executing continuation without a provider-boundary lease', async () => {
    const product = service.importProduct({ workspaceId, platform: 'jd', localProductKey: `executing-continuation-${Date.now()}`, title: '执行中续跑测试商品', stock: 1, price: 19 })
    service.confirmProductFacts(workspaceId, product.id)
    const job = service.enqueueImageGeneration({
      workspaceId,
      productId: product.id,
      idempotencyKey: `executing-continuation-${product.id}`,
      count: 1,
      continuation: { sourceAssetId: 'asset_executing_continuation', state: 'executing', requestedBy: 'merchant-executing', billingState: 'settled' },
    })
    const executePath = `/v1/internal/image-generation-continuations/${encodeURIComponent(job.id)}/execute`
    const response = await fetch(`${base}${executePath}`, { method: 'POST', headers: workerHeaders('POST', executePath) })
    expect(response.status).toBe(409)
    expect((await response.json() as Envelope<null>).error).toMatchObject({ code: 'IMAGE_CONTINUATION_PROVIDER_OUTCOME_UNKNOWN', details: { retryable: false, reconciliation_required: true } })
  })

  it('terminates the saved continuation without billing when the source scan is malicious', async () => {
    const product = service.importProduct({ workspaceId, platform: 'jd', localProductKey: `blocked-continuation-${Date.now()}`, title: '风险素材续跑测试商品', stock: 2, price: 39 })
    service.confirmProductFacts(workspaceId, product.id)
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'merchant-blocked-continuation' }
    const mcp = (id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }).then(response => response.json()) as Promise<any>
    const before = await mcp(20, 'billing.model-usage.statement', {})
    const source = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from('blocked-continuation-source')])
    const uploaded = await mcp(21, 'asset.upload', { name: 'blocked-continuation.png', mime_type: 'image/png', content_base64: source.toString('base64'), continuation_kind: 'image_generation', continuation_product_id: product.id, continuation_count: '1', continuation_idempotency_key: `blocked-continuation-${product.id}` })
    const asset = uploaded.data.result as { id: string; storageKey: string; sha256: string; sizeBytes: number; sourceRevision?: number; scanStatus: string; generationContinuation: { jobId: string } }
    const path = `/v1/internal/assets/${encodeURIComponent(asset.id)}/scan-result`
    const blockedBody = JSON.stringify(signedReceipt(asset, 'malicious'))
    const blocked = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...scannerHeaders('POST', path, blockedBody) }, body: blockedBody })
    expect(blocked.status).toBe(200)
    const job = await mcp(22, 'catalog.image.get', { job_id: asset.generationContinuation.jobId })
    expect(job.data.result.job).toMatchObject({ state: 'queued', continuationState: 'failed', continuationUserActionRequired: false })
    const after = await mcp(23, 'billing.model-usage.statement', {})
    expect(after.data.result.action_ledger.record_count).toBe(before.data.result.action_ledger.record_count)
  })
})
