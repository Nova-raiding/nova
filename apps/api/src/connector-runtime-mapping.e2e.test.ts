import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { evaluatePlatformFieldMapping } from '../../../packages/application/src/platform-field-mapping-gate.js'
import type { RawProduct } from '../../../packages/connectors/src/types.js'
import type { StoredMappingPreflightApproval } from '../../../packages/persistence/src/mapping-preflight-approval-repository.js'

type ApiModule = typeof import('./server.js')
type Envelope<T = unknown> = { data: { result: T } | T | null; error: { code: string; message: string } | null }

let api: ApiModule
let baseUrl = ''

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const canonicalJson = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
    : JSON.stringify(value) ?? 'undefined'

function sourceFields(raw: RawProduct) {
  const fields: Record<string, unknown> = {
    title: raw.title,
    description: raw.description,
    price: raw.price,
    stock: raw.stock,
    category: raw.category,
    merchantSourcePayloadSha256: sha(canonicalJson({ remoteId: raw.remoteId, title: raw.title, description: raw.description, price: raw.price, stock: raw.stock, sku: raw.sku, images: raw.images, category: raw.category, attributes: raw.attributes, platformFields: raw.platformFields, listingStatus: raw.listingStatus ?? null })),
  }
  if (raw.listingStatus !== undefined) fields.listingStatus = raw.listingStatus
  for (const [field, value] of Object.entries(raw.platformFields)) fields[field] = value
  return fields
}

async function startServer() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    api.server.once('error', onError)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', onError); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function mcp(workspaceId: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as Envelope<any> }
}

function approvalSeed(workspaceId: string, product: { id: string; workspaceId: string; platform: StoredMappingPreflightApproval['platform']; accountId?: string; remoteId?: string; category?: string; version?: number }, evaluatedAt: string): StoredMappingPreflightApproval {
  return {
    workspaceId,
    platform: product.platform,
    productId: product.id,
    productVersion: product.version ?? 1,
    mappedPayloadHash: '0'.repeat(64),
    remoteSnapshotHash: sha(`remote:${product.remoteId}`),
    schemaVersion: 'connector-schema-v1',
    schemaEvidenceHash: sha('connector-schema-evidence'),
    mappingVersion: 'connector-mapping-v1',
    mappingEvidenceHash: sha('connector-mapping-evidence'),
    publishable: true,
    confirmationValid: true,
    externallyUnverified: false,
    findingCodes: [],
    evaluatedAt,
    expiresAt: new Date(Date.parse(evaluatedAt) + 60 * 60_000).toISOString(),
    createdBy: 'connector-runtime-e2e',
    revision: 1,
    createdAt: evaluatedAt,
    updatedAt: evaluatedAt,
  }
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('REQUIRE_PLATFORM_GOVERNANCE_GATES', 'true')
  vi.stubEnv('ALLOW_FIXTURE_MAPPING_EVIDENCE', 'true')
  api = await import('./server.js')
  baseUrl = await startServer()
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('API ConnectorRuntime durable mapping preflight wiring', () => {
  it('requires an exact persisted approval for connector sync and isolates tenants', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workspaceId = `ws_connector_mapping_${suffix}`
    const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `remote-account-${suffix}`, credentialRef: `vault://connector/${suffix}` })
    const connector = api.connectorRuntime.connector('taobao')
    const page = await connector.syncProducts({ workspaceId, accountId: account.id })
    const raw = page.items[0]!
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, remoteId: raw.remoteId, title: raw.title, stock: raw.stock, price: raw.price, category: raw.category })
    const evaluatedAt = new Date(Date.now() - 1_000).toISOString()
    const seed = approvalSeed(workspaceId, { ...product, platform: 'taobao' }, evaluatedAt)
    const gate = api.buildConnectorMappingGate({ approval: seed, product, sourceProductId: product.id, fields: sourceFields(raw), category: raw.category })
    expect(gate).toBeDefined()
    const report = evaluatePlatformFieldMapping(gate!)
    expect(report).toMatchObject({ publishable: true, externallyUnverified: false })

    const approved = await mcp(workspaceId, 'platform.mapping.preflight', { input_json: JSON.stringify(gate) })
    expect(approved.body.error).toBeNull()
    expect((approved.body.data as { result: { mappedPayloadHash: string } }).result.mappedPayloadHash).toBe(report.mappedPayloadHash)

    const synced = await mcp(workspaceId, 'catalog.sync', { platform: 'taobao', account_id: account.id })
    expect(synced.status).toBe(200)
    expect(synced.body.error).toBeNull()
    expect((synced.body.data as { result: { products: Array<{ remoteId: string }> } }).result.products).toEqual(expect.arrayContaining([expect.objectContaining({ remoteId: raw.remoteId })]))

    const otherWorkspace = `ws_connector_mapping_other_${suffix}`
    const otherAccount = api.service.registerPlatformAccount({ workspaceId: otherWorkspace, platform: 'taobao', remoteAccountId: `other-account-${suffix}`, credentialRef: `vault://connector/other/${suffix}` })
    api.service.importProduct({ workspaceId: otherWorkspace, platform: 'taobao', accountId: otherAccount.id, remoteId: raw.remoteId, title: raw.title, stock: raw.stock, price: raw.price, category: raw.category })
    const crossTenant = await mcp(otherWorkspace, 'catalog.sync', { platform: 'taobao', account_id: otherAccount.id })
    expect(crossTenant).toMatchObject({ status: 409 })
    expect(crossTenant.body.error?.code).toBe('PLATFORM_MAPPING_PREFLIGHT_REQUIRED')

    product.version = (product.version ?? 1) + 1
    const staleProductVersion = await mcp(workspaceId, 'catalog.sync', { platform: 'taobao', account_id: account.id })
    expect(staleProductVersion).toMatchObject({ status: 409 })
    expect(staleProductVersion.body.error?.code).toBe('PLATFORM_MAPPING_PREFLIGHT_REQUIRED')
    product.version = (product.version ?? 1) - 1

    const originalTitle = product.title
    product.title = `${originalTitle} changed after approval`
    const stalePayload = await mcp(workspaceId, 'catalog.sync', { platform: 'taobao', account_id: account.id })
    expect(stalePayload).toMatchObject({ status: 409 })
    expect(stalePayload.body.error?.code).toBe('PLATFORM_MAPPING_PREFLIGHT_REQUIRED')
    product.title = originalTitle

    const wrongAccount = await mcp(workspaceId, 'catalog.sync', { platform: 'taobao', account_id: otherAccount.id })
    expect(wrongAccount.body.error?.code).toBe('PLATFORM_ACCOUNT_REQUIRED')

  })

  it('reports an empty workspace as unverified rather than returning a green delivery-readiness aggregate', async () => {
    const workspaceId = `ws_delivery_readiness_empty_${randomUUID().slice(0, 8)}`
    const response = await fetch(`${baseUrl}/v1/delivery-readiness`, { headers: { 'x-workspace-id': workspaceId } })
    const body = await response.json() as Envelope<{ status: string; dimensions: Record<string, string>; mappingPreflights: unknown[]; bundles: unknown[]; authenticity: unknown[] }>
    expect(response.status).toBe(200)
    expect(body.error).toBeNull()
    expect(body.data).toMatchObject({ status: 'unverified', dimensions: { mapping: 'unverified', bundles: 'unverified', authenticity: 'unverified' }, mappingPreflights: [], bundles: [], authenticity: [] })
  })
})
