import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomerDelivery } from '../../../packages/persistence/src/customer-delivery-repository.js'

type Rpc<T = unknown> = { data: { result: T } | null; error: { code: string; details?: Record<string, unknown> } | null }
type Envelope = { data: unknown; error: { code: string; message: string } | null }
type UploadView = { assetRef: string; name: string; mimeType: string; sizeBytes: number; scanStatus: 'pending' | 'clean' | 'blocked'; ready: boolean }
type Purpose = 'contract' | 'payment' | 'system_integration' | 'functional_acceptance' | 'training' | 'video'

const platformToken = 'customer-delivery-asset-download-e2e-platform-token'
const scopedPlatformToken = 'customer-delivery-asset-download-e2e-scoped-platform-token'
const merchantToken = 'customer-delivery-asset-download-e2e-merchant-token'
let api: typeof import('./server.js')
let server: typeof import('./server.js').server
let service: typeof import('./server.js').service
let workspaceMembers: typeof import('./server.js').workspaceMembers
let base = ''
let storageRoot = ''
let workspaceId = ''
let otherWorkspaceId = ''

// Byte-accurate single-page PDF (valid xref offsets), mirroring the fixture
// used by customer-delivery-upload.e2e.test.ts.
function pdfBytes(label: string) {
  const stream = `BT /F1 12 Tf 20 50 Td (${label}) Tj ET\n`
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

async function mcp<T>(method: string, params: Record<string, unknown>, options: { token?: string | null; workspace?: string } = {}) {
  const target = options.workspace ?? workspaceId
  const token = options.token === undefined ? platformToken : options.token
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { target_workspace_id: target, ...params } }),
  })
  return { status: response.status, body: await response.json() as Rpc<T> }
}

function successfulResult<T>(response: Awaited<ReturnType<typeof mcp<T>>>): T {
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body.error).toBeNull()
  expect(response.body.data).not.toBeNull()
  return response.body.data!.result
}

async function createDelivery(workspace = workspaceId) {
  return successfulResult(await mcp<CustomerDelivery>('ops.customer-delivery.create', { company_name: `交付下载测试 ${randomUUID()}` }, { workspace }))
}

async function uploadDeliveryAsset(deliveryId: string, workspace = workspaceId, purpose: Purpose = 'contract') {
  const bytes = pdfBytes(`Delivery evidence ${randomUUID()}`)
  return {
    bytes,
    view: successfulResult(await mcp<UploadView>('ops.customer-delivery.assets.upload', {
      delivery_id: deliveryId,
      purpose,
      name: `customer-${purpose}.pdf`,
      mime_type: 'application/pdf',
      content_base64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }, { workspace })),
  }
}

/**
 * Moves an already-uploaded delivery asset from quarantine into the clean zone
 * with the exact bytes on disk and mutates the in-memory scan verdict. This is
 * synthetic trust metadata, not evidence of a real scanner execution; it exists
 * so the download path can be exercised against real stored bytes.
 */
async function promoteCleanBytes(assetRef: string) {
  const asset = service.assets.get(assetRef)!
  const quarantineKey = asset.storageKey
  const cleanKey = quarantineKey.replace(/^quarantine\//u, 'clean/')
  const body = await readFile(join(storageRoot, ...quarantineKey.split('/')))
  const metadata = JSON.parse(await readFile(`${join(storageRoot, ...quarantineKey.split('/'))}.meta.json`, 'utf8')) as Record<string, unknown>
  const cleanPath = join(storageRoot, ...cleanKey.split('/'))
  await mkdir(dirname(cleanPath), { recursive: true })
  await writeFile(cleanPath, body)
  await writeFile(`${cleanPath}.meta.json`, JSON.stringify({ ...metadata, key: cleanKey, zone: 'clean', scanEvidenceRef: 'scanner://customer-delivery-asset-download-e2e' }))
  asset.storageKey = cleanKey
  asset.scanStatus = 'clean'
  asset.scanVerdict = 'clean'
  asset.scanReceiptId = `test-only:${asset.id}`
  asset.scanReceiptDigest = createHash('sha256').update(`test-only:${asset.id}`).digest('hex')
  asset.scanCompletedAt = new Date().toISOString()
  return { cleanKey, body }
}

function download(deliveryId: string, assetRef: string, purpose: Purpose, options: { token?: string | null; target?: string; headerWorkspace?: string | null } = {}) {
  const target = options.target ?? workspaceId
  const token = options.token === undefined ? platformToken : options.token
  // The real Ops Console deliberately sends no workspace header here: the
  // platform workbench is a cross-workspace read that names its target in the
  // path. Callers that do declare a header are bound to it by the route.
  const headerWorkspace = options.headerWorkspace === undefined ? null : options.headerWorkspace
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (headerWorkspace) headers['x-workspace-id'] = headerWorkspace
  const path = `/v1/ops/customer-deliveries/workspaces/${encodeURIComponent(target)}/${encodeURIComponent(deliveryId)}/assets/${encodeURIComponent(assetRef)}/download?purpose=${encodeURIComponent(purpose)}`
  return fetch(`${base}${path}`, { headers })
}

describe('platform customer-delivery asset download over loopback HTTP', () => {
  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'customer-delivery-asset-download-e2e-'))
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'customer-delivery-asset-download-e2e-session-secret')
    vi.stubEnv('ASSET_STORAGE_ROOT', storageRoot)
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    api = await import('./server.js')
    server = api.server
    service = api.service
    workspaceMembers = api.workspaceMembers
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  beforeEach(async () => {
    workspaceId = `ws_delivery_download_${randomUUID()}`
    otherWorkspaceId = `ws_delivery_download_other_${randomUUID()}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [platformToken]: { actor_id: 'delivery-download-platform-operator', roles: ['platform_ops'], workbenches: ['platform'], workspaces: [] },
      [scopedPlatformToken]: { actor_id: 'delivery-download-platform-operator', roles: ['platform_ops'], workbenches: ['platform'], workspaces: [workspaceId, otherWorkspaceId] },
      [merchantToken]: { actor_id: 'delivery-download-workspace-owner', roles: ['workspace_owner'], workbenches: ['workspace'], workspaces: [workspaceId] },
    }))
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'delivery-download-workspace-owner', displayName: 'Delivery download merchant', role: 'workspace_owner', status: 'active', invitedBy: 'isolated-http-test' })
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(otherWorkspaceId)
    await api.grantCreativePointsForTests(otherWorkspaceId)
  })

  afterAll(async () => {
    try {
      if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    } finally {
      vi.unstubAllEnvs()
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('serves the scanned bytes with the recorded content type and a disposition', async () => {
    const delivery = await createDelivery()
    const { view, bytes } = await uploadDeliveryAsset(delivery.id)
    await promoteCleanBytes(view.assetRef)

    const response = await download(delivery.id, view.assetRef, 'contract')
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    const disposition = response.headers.get('content-disposition') ?? ''
    expect(disposition).toContain('filename=')
    expect(disposition).toContain(view.name)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes))
  })

  it('denies a merchant workspace principal with 403 instead of falling through to a route 404', async () => {
    const delivery = await createDelivery()
    const { view } = await uploadDeliveryAsset(delivery.id)
    await promoteCleanBytes(view.assetRef)

    // The merchant is a legitimate member of the tenant that owns the asset,
    // yet the download is a platform control-plane read. The refusal must be
    // an authorization denial and never a route-not-found.
    const response = await download(delivery.id, view.assetRef, 'contract', { token: merchantToken, headerWorkspace: workspaceId })
    expect(response.status, await response.clone().text()).toBe(403)
    expect(response.status).not.toBe(404)
    const body = await response.json() as Envelope
    expect(body.error?.code).toBe('FORBIDDEN')
  })

  it('denies a platform operator whose declared workspace disagrees with the path target', async () => {
    const delivery = await createDelivery()
    const { view } = await uploadDeliveryAsset(delivery.id)
    await promoteCleanBytes(view.assetRef)

    // A token grant that may declare this workspace is still not allowed to
    // read another tenant's evidence by naming it in the path.
    const response = await download(delivery.id, view.assetRef, 'contract', { token: scopedPlatformToken, headerWorkspace: workspaceId, target: otherWorkspaceId })
    expect(response.status, await response.clone().text()).toBe(403)
    const body = await response.json() as Envelope
    expect(body.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
  })

  it('does not expose a delivery asset of another workspace through a mismatched target', async () => {
    const delivery = await createDelivery()
    const { view } = await uploadDeliveryAsset(delivery.id)
    await promoteCleanBytes(view.assetRef)

    // Same asset id and delivery id, but the caller declares the other tenant
    // as the target. The delivery lookup stays scoped to the declared target,
    // so nothing in this workspace resolves.
    const response = await download(delivery.id, view.assetRef, 'contract', { target: otherWorkspaceId })
    expect(response.status, await response.clone().text()).toBe(404)
    const body = await response.json() as Envelope
    expect(body.error?.code).toBe('CUSTOMER_DELIVERY_NOT_FOUND')
  })

  it('returns 404 for an unknown delivery and for an asset that is not bound to the delivery or purpose', async () => {
    const delivery = await createDelivery()
    const { view } = await uploadDeliveryAsset(delivery.id)
    await promoteCleanBytes(view.assetRef)

    const missingDelivery = await download('cd_missing', view.assetRef, 'contract')
    expect(missingDelivery.status).toBe(404)
    expect(((await missingDelivery.json()) as Envelope).error?.code).toBe('CUSTOMER_DELIVERY_NOT_FOUND')

    const unboundAsset = await download(delivery.id, `asset_missing_${randomUUID()}`, 'contract')
    expect(unboundAsset.status).toBe(404)
    expect(((await unboundAsset.json()) as Envelope).error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')

    const wrongPurpose = await download(delivery.id, view.assetRef, 'payment')
    expect(wrongPurpose.status).toBe(404)
    expect(((await wrongPurpose.json()) as Envelope).error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
  })

  it('refuses to serve an asset that has not passed the trusted clean scan', async () => {
    const delivery = await createDelivery()
    const { view } = await uploadDeliveryAsset(delivery.id)

    const response = await download(delivery.id, view.assetRef, 'contract')
    expect(response.status, await response.clone().text()).toBe(409)
    const body = await response.json() as Envelope
    expect(body.error?.code).toBe('CUSTOMER_DELIVERY_CONTRACT_ASSET_NOT_READY')
  })

  it('refuses to serve bytes that no longer match the scanned snapshot', async () => {
    const delivery = await createDelivery()
    const { view } = await uploadDeliveryAsset(delivery.id)
    await promoteCleanBytes(view.assetRef)
    // The scanned snapshot moves on without the stored object, so the byte
    // integrity binding must reject the download.
    service.assets.get(view.assetRef)!.sha256 = createHash('sha256').update(`rotated:${view.assetRef}`).digest('hex')

    const response = await download(delivery.id, view.assetRef, 'contract')
    expect(response.status, await response.clone().text()).toBe(409)
    const body = await response.json() as Envelope
    expect(body.error?.code).toBe('ASSET_BINARY_INTEGRITY_FAILED')
  })
})
