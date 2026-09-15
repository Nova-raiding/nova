import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomerDelivery } from '../../../packages/persistence/src/customer-delivery-repository.js'
import { DomainError } from '../../../packages/application/src/service.js'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import argon2 from 'argon2'

const transport = vi.hoisted(() => ({ download: vi.fn() }))
vi.mock('./customer-delivery-contract-download.js', () => ({ downloadCustomerDeliveryContract: transport.download }))

type Rpc<T> = { data: { result: T } | null; error: { code: string } | null }
type Upload = { assetRef: string; name: string; mimeType: string; scanStatus: string; ready: boolean }
const platformToken = 'delivery-contract-link-platform-token'
const merchantToken = 'delivery-contract-link-merchant-token'
const deniedToken = 'delivery-contract-link-denied-token'
const source = 'https://contracts.example.test/agreement.pdf?signature=do-not-audit-this-secret'
let api: typeof import('./server.js')
let base = ''
let storageRoot = ''
let workspaceId = ''

// Structurally complete PDF fixture. Transport is mocked, but admission and
// quarantine storage run over real loopback HTTP. No scanner is mocked or run.
function pdfBytes() {
  const stream = `BT /F1 12 Tf 20 50 Td (Contract ${randomUUID()}) Tj ET\n`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let text = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(text)
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text)
}

async function call<T = unknown>(method: string, params: Record<string, unknown>, token: string | null = platformToken, target = workspaceId) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { target_workspace_id: target, ...params } }) })
  return { status: response.status, body: await response.json() as Rpc<T> }
}
function result<T>(response: Awaited<ReturnType<typeof call<T>>>) {
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body.error).toBeNull()
  return response.body.data!.result
}
async function createDelivery(target = workspaceId) { return result(await call<CustomerDelivery>('ops.customer-delivery.create', { company_name: `合同链接 ${randomUUID()}` }, platformToken, target)) }
const linkParams = (id: string) => ({ delivery_id: id, purpose: 'contract', source_url: source })
const files = () => readdir(storageRoot, { recursive: true })

describe('contract link ingestion: real loopback HTTP/quarantine, mocked download, no scanner evidence', () => {
  beforeAll(async () => {
    for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'REDIS_URL', 'PGHOST', 'ASSET_STORAGE_ENDPOINT']) if (process.env[key]) throw new Error(`Run safe-tests: inherited ${key} is forbidden`)
    storageRoot = await mkdtemp(join(tmpdir(), 'customer-delivery-contract-link-'))
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AUTH_ENFORCEMENT', 'strict'); vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'delivery-contract-link-session-secret')
    vi.stubEnv('ASSET_STORAGE_ROOT', storageRoot); vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'false'); vi.stubEnv('ASSET_SCANNER_MODE', 'clamav_worker')
    api = await import('./server.js')
    await new Promise<void>((resolve, reject) => { api.server.once('error', reject); api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', reject); resolve() }) })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('loopback bind failed')
    base = `http://127.0.0.1:${address.port}`
  })
  beforeEach(async () => {
    workspaceId = `ws_contract_link_${randomUUID()}`
    transport.download.mockReset()
    const bytes = pdfBytes(); const digest = createHash('sha256').update(bytes).digest('hex')
    transport.download.mockResolvedValue({ name: `contract-${digest.slice(0, 16)}.pdf`, mime_type: 'application/pdf', content_base64: bytes.toString('base64'), sha256: digest })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [platformToken]: { actor_id: 'contract-link-operator', roles: ['platform_ops'], workbenches: ['platform'], workspaces: [] },
      [deniedToken]: { actor_id: 'contract-link-denied', roles: ['platform_ops'], denied_capabilities: ['customer.delivery.update'], workbenches: ['platform'], workspaces: [] },
      [merchantToken]: { actor_id: 'contract-link-merchant', roles: ['workspace_owner'], workbenches: ['workspace'], workspaces: [workspaceId] },
    }))
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: 'contract-link-merchant', displayName: 'isolated merchant', role: 'workspace_owner', status: 'active', invitedBy: 'http-test' })
  })
  afterAll(async () => {
    try { if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve())) }
    finally { vi.unstubAllEnvs(); if (storageRoot) await rm(storageRoot, { recursive: true, force: true }) }
  })

  it('downloads an authorized URL into quarantine without completing the contract or leaking its signed URL', async () => {
    const delivery = await createDelivery()
    const uploaded = result(await call<Upload>('ops.customer-delivery.assets.upload', linkParams(delivery.id)))
    expect(transport.download).toHaveBeenCalledTimes(1)
    expect(transport.download.mock.calls[0]![0]).toBe(source)
    expect(uploaded).toMatchObject({ scanStatus: 'pending', ready: false, mimeType: 'application/pdf' })
    const asset = api.service.assets.get(uploaded.assetRef)!
    expect(asset.storageKey.startsWith(`quarantine/${workspaceId}/`)).toBe(true)
    expect(asset.scanReceiptId).toBeUndefined(); expect(asset.scanReceiptDigest).toBeUndefined()
    const downloaded = await transport.download.mock.results[0]!.value
    expect(await readFile(join(storageRoot, asset.storageKey))).toEqual(Buffer.from(downloaded.content_base64, 'base64'))
    expect(JSON.stringify(asset)).not.toContain(source)
    expect(JSON.stringify(await api.operationAudits.list(workspaceId))).not.toContain('do-not-audit-this-secret')
    const rejected = await call('ops.customer-delivery.update', { delivery_id: delivery.id, expected_revision: String(delivery.revision), patch_json: JSON.stringify({ contractRef: uploaded.assetRef }) })
    expect(rejected.status).toBe(409); expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_CONTRACT_ASSET_NOT_READY')
    expect(result(await call<CustomerDelivery>('ops.customer-delivery.get', { delivery_id: delivery.id }))).toEqual(delivery)
  })

  it.each([null, merchantToken, deniedToken])('denies unauthorized caller %s before download or persistence', async token => {
    const delivery = await createDelivery(); const before = await files()
    const rejected = await call('ops.customer-delivery.assets.upload', linkParams(delivery.id), token)
    expect(rejected.status).toBeGreaterThanOrEqual(400); expect(transport.download).not.toHaveBeenCalled()
    expect(api.service.listAssets(workspaceId)).toEqual([]); expect(await files()).toEqual(before)
  })
  it('rejects cross-workspace and nonexistent deliveries before downloading', async () => {
    const other = await createDelivery(`ws_other_contract_${randomUUID()}`)
    for (const id of [other.id, `missing_${randomUUID()}`]) {
      const rejected = await call('ops.customer-delivery.assets.upload', linkParams(id))
      expect(rejected.status).toBe(404)
    }
    expect(transport.download).not.toHaveBeenCalled(); expect(api.service.listAssets(workspaceId)).toEqual([])
  })
  it.each([
    { content_base64: 'JVBERi0xLjQK' }, { purpose: 'video' }, { purpose: 'payment' },
    { purpose: 'system_integration' }, { purpose: 'functional_acceptance' }, { purpose: 'training' },
    { name: 'client.pdf' }, { mime_type: 'application/pdf' }, { sha256: 'a'.repeat(64) },
  ])('rejects ambiguous/forbidden client fields %j before download', async extra => {
    const delivery = await createDelivery(); const before = await files()
    const rejected = await call('ops.customer-delivery.assets.upload', { ...linkParams(delivery.id), ...extra })
    expect(rejected.status).toBe(400); expect(transport.download).not.toHaveBeenCalled()
    expect(api.service.listAssets(workspaceId)).toEqual([]); expect(await files()).toEqual(before)
  })
  it('does not persist a failed download', async () => {
    const delivery = await createDelivery(); const before = await files()
    transport.download.mockRejectedValueOnce(new DomainError('CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_FAILED', 'Contract download failed', 502))
    const rejected = await call('ops.customer-delivery.assets.upload', linkParams(delivery.id))
    expect(rejected.status).toBe(502); expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_FAILED'); expect(transport.download).toHaveBeenCalledTimes(1)
    expect(api.service.listAssets(workspaceId)).toEqual([]); expect(await files()).toEqual(before)
    expect(result(await call<CustomerDelivery>('ops.customer-delivery.get', { delivery_id: delivery.id }))).toEqual(delivery)
  })

  it('rechecks a real password session revoked during download before writing any asset', async () => {
    const delivery = await createDelivery(); const before = await files()
    const repository = new MemoryPasswordAuthRepository()
    const password = 'Isolated-contract-7654321'
    await repository.ensurePlatformAccount({ login: 'contract-session-recheck', passwordHash: await argon2.hash(password), roles: ['platform_ops'] })
    const { token } = await repository.login({ login: 'contract-session-recheck', password })
    const downloaded = await transport.download(source)
    transport.download.mockClear()
    transport.download.mockImplementationOnce(async () => { await repository.logout(token); return downloaded })
    api.setPasswordAuthRepositoryForTests(repository)
    try {
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `damai_session=${encodeURIComponent(token)}` }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'ops.customer-delivery.assets.upload', params: { target_workspace_id: workspaceId, ...linkParams(delivery.id) } }) })
      expect(response.status).toBe(401)
      expect((await response.json()).error.code).toBe('AUTH_SESSION_INVALID')
      expect(transport.download).toHaveBeenCalledTimes(1)
      expect(api.service.listAssets(workspaceId)).toEqual([])
      expect(await files()).toEqual(before)
    } finally { api.setPasswordAuthRepositoryForTests() }
  })

  it('cancels the outbound download when the real requesting socket closes', async () => {
    const delivery = await createDelivery(); const before = await files()
    let entered!: () => void; let cancelled!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const stopped = new Promise<void>(resolve => { cancelled = resolve })
    transport.download.mockImplementationOnce((_source: string, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      const stop = () => { cancelled(); reject(new DomainError('CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_CANCELLED', 'Cancelled', 499)) }
      signal.addEventListener('abort', stop, { once: true }); entered()
      if (signal.aborted) stop()
    }))
    const controller = new AbortController()
    const request = fetch(`${base}/mcp`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${platformToken}` }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'ops.customer-delivery.assets.upload', params: { target_workspace_id: workspaceId, ...linkParams(delivery.id) } }) })
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await started; controller.abort(); await rejected; await stopped
    expect(api.service.listAssets(workspaceId)).toEqual([])
    expect(await files()).toEqual(before)
  })
})
