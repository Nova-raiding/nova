import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomerDelivery } from '../../../packages/persistence/src/customer-delivery-repository.js'

type Rpc<T = unknown> = { data: { result: T } | null; error: { code: string; details?: Record<string, unknown> } | null }
type UploadView = { assetRef: string; name: string; mimeType: string; sizeBytes: number; scanStatus: 'pending' | 'clean' | 'blocked'; ready: boolean }
type Purpose = 'contract' | 'payment' | 'system_integration' | 'functional_acceptance' | 'training' | 'video'

const platformToken = 'customer-delivery-upload-e2e-platform-token'
const merchantToken = 'customer-delivery-upload-e2e-merchant-token'
let server: typeof import('./server.js').server
let service: typeof import('./server.js').service
let workspaceMembers: typeof import('./server.js').workspaceMembers
let base = ''
let storageRoot = ''
let workspaceId = ''

// Complete single-page PDF with byte-accurate xref offsets, not only magic bytes.
function pdfBytes() {
  const stream = `BT /F1 12 Tf 20 50 Td (Delivery contract ${randomUUID()}) Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let source = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source))
    source += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(source)
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(source)
}

// The same real ffmpeg-produced one-frame 16x16 MP4 used by
// asset-upload-video-security.test.ts. No ffmpeg installation needed in CI.
const mp4Bytes = Buffer.from('AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAwttb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACWnRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAABAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAA+gAAAAAAAEAAAAAAdJtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAABAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAF9bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABPXN0YmwAAADZc3RzZAAAAAAAAAABAAAAyW1wNHYAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAEKTGF2YyBtcGVnNAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAABPZXNkcwAAAAADgICAPgABAASAgIAwIBEAAAAAAw1AAAAAiAWAgIAeAAABsAEAAAG1iRMAAAEAAAABIADEjYgADQCEAhRjBoCAgAECAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAADDUAAAACIAAAAGHN0dHMAAAAAAAAAAQAAAAEAAEAAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAABEAAAABAAAAFHN0Y28AAAAAAAAAAQAAAzcAAAA9dWR0YQAAADVtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAAhpbHN0AAAACGZyZWUAAAAZbWRhdAAAAbMAEAcAAAG2FgUYI9t+', 'base64')

function uploadParams(deliveryId: string, purpose: Purpose = 'contract', bytes = purpose === 'video' ? mp4Bytes : pdfBytes()) {
  return {
    delivery_id: deliveryId,
    purpose,
    name: purpose === 'video' ? 'customer-delivery.mp4' : `customer-${purpose}.pdf`,
    mime_type: purpose === 'video' ? 'video/mp4' : 'application/pdf',
    content_base64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function call<T>(method: string, params: Record<string, unknown>, options: { token?: string | null; workspace?: string; workspaceHeader?: boolean } = {}) {
  const target = options.workspace ?? workspaceId
  const token = options.token === undefined ? platformToken : options.token
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.workspaceHeader ? { 'x-workspace-id': target } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { target_workspace_id: target, ...params } }),
  })
  return { status: response.status, body: await response.json() as Rpc<T> }
}

function successfulResult<T>(response: Awaited<ReturnType<typeof call<T>>>): T {
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body.error).toBeNull()
  expect(response.body.data).not.toBeNull()
  return response.body.data!.result
}

async function createDelivery(target = workspaceId) {
  return successfulResult(await call<CustomerDelivery>('ops.customer-delivery.create', { company_name: `上传HTTP测试 ${randomUUID()}` }, { workspace: target }))
}

async function getDelivery(deliveryId: string) {
  return successfulResult(await call<CustomerDelivery>('ops.customer-delivery.get', { delivery_id: deliveryId }))
}

async function storedEntries() {
  return (await readdir(storageRoot, { recursive: true })).sort()
}

async function expectRejectedUpload(delivery: CustomerDelivery, params: Record<string, unknown>, code: string, status = 400) {
  const beforeFiles = await storedEntries()
  const rejected = await call('ops.customer-delivery.assets.upload', params)
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(status)
  expect(rejected.body.error?.code).toBe(code)
  expect(service.listAssets(workspaceId)).toEqual([])
  expect(await storedEntries()).toEqual(beforeFiles)
  expect(await getDelivery(delivery.id)).toEqual(delivery)
}

describe('customer delivery uploads over strict loopback HTTP with real quarantine files (no scanner execution)', () => {
  it.each(['systemIntegrationStatus', 'functionalAcceptanceStatus', 'trainingCompleted', 'trainingEvidenceRefs'])(
    'rejects direct profile patch of controlled field %s without changing the record', async field => {
      const delivery = await createDelivery()
      const patch = { companyName: 'must not persist', [field]: field.endsWith('Refs') ? [] : field === 'trainingCompleted' ? true : 'complete' }
      const rejected = await call('ops.customer-delivery.update', { delivery_id: delivery.id, expected_revision: String(delivery.revision), patch_json: JSON.stringify(patch) })
      expect(rejected.status).toBe(400)
      expect(rejected.body.error?.code).toBe('INVALID_REQUEST')
      expect(await getDelivery(delivery.id)).toEqual(delivery)
    },
  )

  it.each((['system_integration', 'functional_acceptance'] as const).flatMap(checklistKey =>
    ['true', 'false'].map(completed => ({ checklistKey, completed }))))(
    'rejects scalar $checklistKey=$completed instead of diverging from item rows', async ({ checklistKey, completed }) => {
      const delivery = await createDelivery()
      const rejected = await call('ops.customer-delivery.checklist.update', {
        delivery_id: delivery.id, checklist_key: checklistKey, completed, expected_revision: String(delivery.revision),
      })
      expect(rejected.status).toBe(400)
      expect(rejected.body.error?.code).toBe('INVALID_REQUEST')
      expect(await getDelivery(delivery.id)).toEqual(delivery)
      expect(successfulResult(await call<{ items: unknown[] }>('ops.customer-delivery.checklist-items.list', {
        delivery_id: delivery.id, checklist_key: checklistKey,
      })).items).toEqual([])
    },
  )

  it.each([null, '', 'https://example.com/not-an-upload.pdf', 'asset with spaces', 42, {}])(
    'rejects malformed evidence array elements atomically (%j)', async invalidRef => {
      const delivery = await createDelivery()
      const payment = await call('ops.customer-delivery.update', {
        delivery_id: delivery.id, expected_revision: String(delivery.revision),
        patch_json: JSON.stringify({ companyName: 'must not persist', paymentEvidenceRefs: [invalidRef] }),
      })
      const training = await call('ops.customer-delivery.training.complete', {
        delivery_id: delivery.id, expected_revision: String(delivery.revision), completed: 'false', evidence_refs_json: JSON.stringify([invalidRef]),
      })
      for (const response of [payment, training]) {
        expect(response.status).toBe(400)
        expect(response.body.error?.code).toBe('INVALID_REQUEST')
      }
      expect(await getDelivery(delivery.id)).toEqual(delivery)
    },
  )

  it('keeps an unpaid draft editable without inventing payment or training evidence', async () => {
    const delivery = await createDelivery()
    const updated = successfulResult(await call<CustomerDelivery>('ops.customer-delivery.update', {
      delivery_id: delivery.id, expected_revision: String(delivery.revision), patch_json: JSON.stringify({ supportOwner: '真实接口草稿测试' }),
    }))
    expect(updated).toMatchObject({ supportOwner: '真实接口草稿测试', paymentStatus: 'unpaid', paymentEvidenceRefs: [], trainingCompleted: false, trainingEvidenceRefs: [], effectiveAt: null })
    expect(updated.revision).toBe(delivery.revision + 1)
    expect(await getDelivery(delivery.id)).toEqual(updated)
  })

  beforeAll(async () => {
    // Import the API only after rejecting external persistence configuration.
    // scripts/run-safe-tests.ts strips these values and supplies an isolated
    // environment. This suite must never connect to a shared database or Redis.
    for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'REDIS_URL', 'PGHOST', 'ASSET_STORAGE_ENDPOINT']) {
      if (process.env[key]) throw new Error(`Run through scripts/run-safe-tests.ts; inherited ${key} is not permitted`)
    }
    storageRoot = await mkdtemp(join(tmpdir(), 'customer-delivery-upload-e2e-'))
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'customer-delivery-upload-e2e-session-secret')
    vi.stubEnv('ASSET_STORAGE_ROOT', storageRoot)
    vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'false')
    vi.stubEnv('ASSET_SCANNER_MODE', 'clamav_worker')
    const api = await import('./server.js')
    server = api.server
    service = api.service
    workspaceMembers = api.workspaceMembers
    await new Promise<void>((resolveListen, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolveListen() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  it('requires a delivery-bound, trusted-clean payment upload before saving paid status', async () => {
    const delivery = await createDelivery()
    const pending = successfulResult(await call<UploadView>('ops.customer-delivery.assets.upload', uploadParams(delivery.id, 'payment')))
    expect(pending).toMatchObject({ scanStatus: 'pending', ready: false })
    const rejected = await call('ops.customer-delivery.update', { delivery_id: delivery.id, expected_revision: String(delivery.revision), patch_json: JSON.stringify({ paymentStatus: 'paid', paymentDate: '2026-09-14', paymentEvidenceRefs: [pending.assetRef] }) })
    expect(rejected.status).toBe(409)
    expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_PAYMENT_ASSET_NOT_READY')

    // Synthetic trust-state mutation validates the registration gate only;
    // it is not evidence of a scanner execution.
    const asset = service.assets.get(pending.assetRef)!
    asset.storageKey = asset.storageKey.replace(/^quarantine\//u, 'clean/')
    asset.scanStatus = 'clean'
    asset.scanVerdict = 'clean'
    asset.scanReceiptId = `test-only:${asset.id}`
    asset.scanReceiptDigest = createHash('sha256').update(asset.scanReceiptId).digest('hex')
    const paid = successfulResult(await call<CustomerDelivery>('ops.customer-delivery.update', { delivery_id: delivery.id, expected_revision: String(delivery.revision), patch_json: JSON.stringify({ paymentStatus: 'paid', paymentDate: '2026-09-14', paymentEvidenceRefs: [pending.assetRef] }) }))
    expect(paid).toMatchObject({ paymentStatus: 'paid', paymentEvidenceRefs: [pending.assetRef] })
  })

  it('requires purpose-bound scanned evidence for checklist items and training completion', async () => {
    const delivery = await createDelivery()
    const uploadAndTrust = async (purpose: Purpose) => {
      const uploaded = successfulResult(await call<UploadView>('ops.customer-delivery.assets.upload', uploadParams(delivery.id, purpose)))
      const asset = service.assets.get(uploaded.assetRef)!
      asset.storageKey = asset.storageKey.replace(/^quarantine\//u, 'clean/')
      asset.scanStatus = 'clean'; asset.scanVerdict = 'clean'; asset.scanReceiptId = `test-only:${asset.id}`
      asset.scanReceiptDigest = createHash('sha256').update(asset.scanReceiptId).digest('hex')
      return uploaded.assetRef
    }
    const paymentRef = await uploadAndTrust('payment')
    const paid = successfulResult(await call<CustomerDelivery>('ops.customer-delivery.update', { delivery_id: delivery.id, expected_revision: String(delivery.revision), patch_json: JSON.stringify({ paymentStatus: 'paid', paymentDate: '2026-09-14', paymentEvidenceRefs: [paymentRef] }) }))

    const missingChecklist = await call('ops.customer-delivery.checklist-item.update', { delivery_id: delivery.id, checklist_key: 'system_integration', item_key: '店铺连接', completed: 'true', evidence_json: JSON.stringify({ note: '只有说明' }), expected_revision: String(paid.revision) })
    expect(missingChecklist.status).toBe(400)
    const integrationRef = await uploadAndTrust('system_integration')
    successfulResult(await call('ops.customer-delivery.checklist-item.update', { delivery_id: delivery.id, checklist_key: 'system_integration', item_key: '店铺连接', completed: 'true', evidence_json: JSON.stringify({ note: '接入记录', asset_refs: [integrationRef] }), expected_revision: String(paid.revision) }))
    const afterChecklist = await getDelivery(delivery.id)

    const missingTraining = await call('ops.customer-delivery.training.complete', { delivery_id: delivery.id, completed: 'true', evidence_refs_json: '[]', expected_revision: String(afterChecklist.revision) })
    expect(missingTraining.status).toBe(409)
    const trainingRef = await uploadAndTrust('training')
    const trained = successfulResult(await call<CustomerDelivery>('ops.customer-delivery.training.complete', { delivery_id: delivery.id, completed: 'true', evidence_refs_json: JSON.stringify([trainingRef]), expected_revision: String(afterChecklist.revision) }))
    expect(trained).toMatchObject({ trainingCompleted: true, trainingEvidenceRefs: [trainingRef] })
  })

  beforeEach(async () => {
    workspaceId = `ws_delivery_upload_${randomUUID()}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [platformToken]: { actor_id: 'delivery-upload-platform-operator', roles: ['platform_ops'], workbenches: ['platform'], workspaces: [] },
      [merchantToken]: { actor_id: 'delivery-upload-workspace-owner', roles: ['workspace_owner'], workbenches: ['workspace'], workspaces: [workspaceId] },
    }))
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'delivery-upload-workspace-owner', displayName: 'HTTP test merchant', role: 'workspace_owner', status: 'active', invitedBy: 'isolated-http-test' })
  })

  afterAll(async () => {
    try {
      if (server?.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    } finally {
      vi.unstubAllEnvs()
      // This exact directory was created above by this suite's mkdtemp; never
      // remove an inherited ASSET_STORAGE_ROOT or any shared container volume.
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it.each(['contract', 'video'] as const)('writes real %s bytes to quarantine, returns pending, and refuses premature registration', async purpose => {
    const delivery = await createDelivery()
    const bytes = purpose === 'contract' ? pdfBytes() : mp4Bytes
    const params = uploadParams(delivery.id, purpose, bytes)
    const uploaded = successfulResult(await call<UploadView>('ops.customer-delivery.assets.upload', params))
    expect(uploaded).toMatchObject({ name: params.name, mimeType: params.mime_type, sizeBytes: bytes.length, scanStatus: 'pending', ready: false })
    for (const field of ['storageKey', 'storage_key', 'content_base64', 'scanReceiptId', 'scanReceiptDigest']) expect(uploaded).not.toHaveProperty(field)

    const asset = service.assets.get(uploaded.assetRef)
    expect(asset).toMatchObject({ workspaceId, sha256: params.sha256, scanStatus: 'quarantined' })
    expect(asset?.scanReceiptId).toBeUndefined()
    expect(asset?.scanReceiptDigest).toBeUndefined()
    expect(asset?.storageKey.startsWith(`quarantine/${workspaceId}/`)).toBe(true)
    const storedPath = resolve(storageRoot, asset!.storageKey)
    expect(storedPath.startsWith(`${resolve(storageRoot)}${sep}`)).toBe(true)
    expect(await readFile(storedPath)).toEqual(bytes)
    expect((await storedEntries()).filter(entry => entry.startsWith(`clean/${workspaceId}/`))).toEqual([])

    const status = successfulResult(await call<UploadView>('ops.customer-delivery.assets.get', { delivery_id: delivery.id, purpose, asset_ref: uploaded.assetRef }))
    expect(status).toEqual(uploaded)
    const rejected = purpose === 'contract'
      ? await call('ops.customer-delivery.update', { delivery_id: delivery.id, expected_revision: String(delivery.revision), patch_json: JSON.stringify({ contractRef: uploaded.assetRef }) })
      : await call('ops.customer-delivery.videos.add', { delivery_id: delivery.id, title: '待扫描视频', asset_ref: uploaded.assetRef })
    expect(rejected.status).toBe(409)
    expect(rejected.body.error?.code).toBe(`CUSTOMER_DELIVERY_${purpose.toUpperCase()}_ASSET_NOT_READY`)
    expect(await getDelivery(delivery.id)).toEqual(delivery)
  })

  it('rejects a wrong digest before storing bytes or changing delivery data', async () => {
    const delivery = await createDelivery()
    await expectRejectedUpload(delivery, { ...uploadParams(delivery.id), sha256: '0'.repeat(64) }, 'CUSTOMER_DELIVERY_UPLOAD_DIGEST_MISMATCH')
  })

  it.each([['contract', 'video/mp4'], ['video', 'application/pdf']] as const)('rejects purpose %s with MIME %s before storing bytes', async (purpose, mime_type) => {
    const delivery = await createDelivery()
    await expectRejectedUpload(delivery, { ...uploadParams(delivery.id, purpose), mime_type }, 'CUSTOMER_DELIVERY_UPLOAD_TYPE_UNSUPPORTED')
  })

  it('rejects PDF bytes disguised as an MP4 at the real upload admission boundary', async () => {
    const delivery = await createDelivery()
    const beforeFiles = await storedEntries()
    const rejected = await call('ops.customer-delivery.assets.upload', uploadParams(delivery.id, 'video', pdfBytes()))
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(415)
    expect(rejected.body.error?.details?.reason_codes).toEqual(expect.arrayContaining(['ASSET_MIME_SIGNATURE_MISMATCH']))
    expect(service.listAssets(workspaceId)).toEqual([])
    expect(await storedEntries()).toEqual(beforeFiles)
    expect(await getDelivery(delivery.id)).toEqual(delivery)
  })

  it.each(['upload', 'get'] as const)('rejects a missing delivery before asset %s', async operation => {
    const beforeFiles = await storedEntries()
    const params = operation === 'upload' ? uploadParams('cd_missing') : { delivery_id: 'cd_missing', purpose: 'contract', asset_ref: 'asset_missing' }
    const rejected = await call(`ops.customer-delivery.assets.${operation}`, params)
    expect(rejected.status).toBe(404)
    expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_NOT_FOUND')
    expect(service.listAssets(workspaceId)).toEqual([])
    expect(await storedEntries()).toEqual(beforeFiles)
  })

  it.each(['upload', 'get'] as const)('denies a workspace merchant and an unauthenticated caller from asset %s', async operation => {
    const delivery = await createDelivery()
    const beforeFiles = await storedEntries()
    const params = operation === 'upload' ? uploadParams(delivery.id) : { delivery_id: delivery.id, purpose: 'contract', asset_ref: 'asset_missing' }
    const merchant = await call(`ops.customer-delivery.assets.${operation}`, params, { token: merchantToken, workspaceHeader: true })
    expect(merchant.status).toBe(403)
    expect(merchant.body.error?.code).toBe('FORBIDDEN')
    const anonymous = await call(`ops.customer-delivery.assets.${operation}`, params, { token: null, workspaceHeader: true })
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error?.code).toBe('UNAUTHENTICATED')
    expect(service.listAssets(workspaceId)).toEqual([])
    expect(await storedEntries()).toEqual(beforeFiles)
    expect(await getDelivery(delivery.id)).toEqual(delivery)
  })

  it('does not expose another tenant’s upload when given a valid delivery in the target tenant', async () => {
    const delivery = await createDelivery()
    const uploaded = successfulResult(await call<UploadView>('ops.customer-delivery.assets.upload', uploadParams(delivery.id)))
    const otherWorkspace = `ws_delivery_upload_other_${randomUUID()}`
    const otherDelivery = await createDelivery(otherWorkspace)
    const rejected = await call('ops.customer-delivery.assets.get', { delivery_id: otherDelivery.id, purpose: 'contract', asset_ref: uploaded.assetRef }, { workspace: otherWorkspace })
    expect(rejected.status).toBe(404)
    expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
    expect(rejected.body.data).toBeNull()
    expect(successfulResult(await call<UploadView>('ops.customer-delivery.assets.get', { delivery_id: delivery.id, purpose: 'contract', asset_ref: uploaded.assetRef }))).toEqual(uploaded)
  })

  it('rejects an uploaded contract queried as a video', async () => {
    const delivery = await createDelivery()
    const uploaded = successfulResult(await call<UploadView>('ops.customer-delivery.assets.upload', uploadParams(delivery.id)))
    const rejected = await call('ops.customer-delivery.assets.get', { delivery_id: delivery.id, purpose: 'video', asset_ref: uploaded.assetRef })
    expect(rejected.status).toBe(404)
    expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
    expect(rejected.body.data).toBeNull()
  })

  it('does not expose an ordinary merchant asset through an unrelated delivery in the same workspace', async () => {
    const delivery = await createDelivery()
    const bytes = pdfBytes()
    // Ordinary merchant metadata is deliberately not uploaded through the
    // delivery endpoint and has no delivery association or clean-scan receipt.
    const ordinaryAsset = service.registerAsset({
      workspaceId,
      name: 'ordinary-merchant-file.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      storageKey: `quarantine/${workspaceId}/ordinary-merchant/${randomUUID()}/source`,
    })
    const rejected = await call('ops.customer-delivery.assets.get', { delivery_id: delivery.id, purpose: 'contract', asset_ref: ordinaryAsset.id })
    expect(rejected.status).toBe(404)
    expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
    expect(rejected.body.data).toBeNull()
    expect(await getDelivery(delivery.id)).toEqual(delivery)
  })

  it('does not expose one delivery’s upload through another delivery in the same workspace', async () => {
    const delivery = await createDelivery()
    const uploaded = successfulResult(await call<UploadView>('ops.customer-delivery.assets.upload', uploadParams(delivery.id)))
    const otherDelivery = await createDelivery()
    const rejected = await call('ops.customer-delivery.assets.get', { delivery_id: otherDelivery.id, purpose: 'contract', asset_ref: uploaded.assetRef })
    expect(rejected.status).toBe(404)
    expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
    expect(rejected.body.data).toBeNull()
    expect(await getDelivery(otherDelivery.id)).toEqual(otherDelivery)
    expect(successfulResult(await call<UploadView>('ops.customer-delivery.assets.get', { delivery_id: delivery.id, purpose: 'contract', asset_ref: uploaded.assetRef }))).toEqual(uploaded)
  })

  it.each(['contract', 'video'] as const)(
    'does not register one delivery’s trusted-clean %s asset on another delivery in the same workspace',
    async purpose => {
      const sourceDelivery = await createDelivery()
      const targetDelivery = await createDelivery()
      const uploaded = successfulResult(await call<UploadView>('ops.customer-delivery.assets.upload', uploadParams(sourceDelivery.id, purpose)))
      const asset = service.assets.get(uploaded.assetRef)!
      asset.storageKey = asset.storageKey.replace(/^quarantine\//u, 'clean/')
      asset.scanStatus = 'clean'
      asset.scanVerdict = 'clean'
      asset.scanReceiptId = `test-only:${asset.id}`
      asset.scanReceiptDigest = createHash('sha256').update(asset.scanReceiptId).digest('hex')

      const rejected = purpose === 'contract'
        ? await call('ops.customer-delivery.update', {
          delivery_id: targetDelivery.id,
          expected_revision: String(targetDelivery.revision),
          patch_json: JSON.stringify({ contractRef: uploaded.assetRef }),
        })
        : await call('ops.customer-delivery.videos.add', {
          delivery_id: targetDelivery.id,
          title: '跨交付复用不应成功',
          asset_ref: uploaded.assetRef,
        })

      expect(rejected.status).toBe(404)
      expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
      expect(rejected.body.data).toBeNull()
      expect(await getDelivery(targetDelivery.id)).toEqual(targetDelivery)

      const registered = purpose === 'contract'
        ? successfulResult(await call<CustomerDelivery>('ops.customer-delivery.update', {
          delivery_id: sourceDelivery.id,
          expected_revision: String(sourceDelivery.revision),
          patch_json: JSON.stringify({ contractRef: uploaded.assetRef }),
        }))
        : successfulResult(await call('ops.customer-delivery.videos.add', {
          delivery_id: sourceDelivery.id,
          title: '精确绑定交付视频',
          asset_ref: uploaded.assetRef,
        }))
      expect(registered).toBeTruthy()
    },
  )
})
