import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { evaluatePlatformFieldMapping, type PlatformFieldMappingGateInput } from '../../../packages/application/src/platform-field-mapping-gate.js'

type ApiModule = typeof import('./server.js')
type Envelope<T = unknown> = {
  data: { result: T } | null
  error: { code: string; message: string; details?: Record<string, unknown> } | null
}

let api: ApiModule
let baseUrl = ''

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

async function startServer() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    api.server.once('error', onError)
    api.server.listen(0, '127.0.0.1', () => {
      api.server.removeListener('error', onError)
      resolve()
    })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function mcp<T = unknown>(input: {
  token?: string
  workspaceId: string
  method: string
  params?: Record<string, unknown>
}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: input.token ? `Bearer ${input.token}` : '',
      'content-type': 'application/json',
      'x-workspace-id': input.workspaceId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: input.method,
      params: { workspace_id: input.workspaceId, ...(input.params ?? {}) },
    }),
  })
  return { status: response.status, body: await response.json() as Envelope<T> }
}

function mappingInput(productId: string, overrides: { platform?: string; remoteSnapshotHash?: string } = {}) {
  const schemaHash = sha('mapping-contract-schema')
  const mappingHash = sha('mapping-contract-rules')
  const remoteSnapshotHash = overrides.remoteSnapshotHash ?? sha('mapping-contract-remote-v1')
  const input: PlatformFieldMappingGateInput = {
    platform: overrides.platform ?? 'taobao',
    category: 'apparel',
    schema: {
      source: 'official' as const,
      version: 'schema-v1',
      immutableEvidence: { state: 'production_canary' as const, reference: 'evidence://schema', sha256: schemaHash, capturedAt: '2026-08-31T00:00:00.000Z' },
      fields: [{ name: 'title', scope: 'product' as const, required: true, type: 'string' as const }],
    },
    mapping: {
      version: 'mapping-v1',
      schemaVersion: 'schema-v1',
      immutableEvidence: { state: 'production_canary' as const, reference: 'evidence://mapping', sha256: mappingHash, capturedAt: '2026-08-31T00:00:00.000Z' },
      rules: [{ scope: 'product' as const, sourceField: 'name', targetField: 'title' }],
    },
    source: { productId, productFields: { name: '映射契约测试商品' }, skuPages: [{ items: [{ skuId: 'sku-1', fields: {} }] }] },
    remoteSnapshot: { hash: remoteSnapshotHash, schemaVersion: 'schema-v1' },
  }
  const preview = evaluatePlatformFieldMapping(input)
  input.remoteSnapshot = {
    ...input.remoteSnapshot,
    confirmation: {
      id: 'mapping-confirmation-1',
      schemaVersion: 'schema-v1',
      schemaEvidenceHash: schemaHash,
      mappingVersion: 'mapping-v1',
      mappingEvidenceHash: mappingHash,
      payloadHash: preview.mappedPayloadHash,
      remoteSnapshotHash,
      confirmedBy: 'mapping-contract-test',
      confirmedAt: '2026-08-31T00:00:00.000Z',
    },
  }
  return input
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'platform-mapping-contract-session-secret')
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

describe('platform mapping preflight API contract', () => {
  it('enforces OAuth-authenticated workspace scope before evaluating mapping input', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workspaceId = `ws_mapping_oauth_${suffix}`
    const foreignWorkspaceId = `ws_mapping_oauth_foreign_${suffix}`
    const token = `mapping-oauth-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [token]: { workspaces: [workspaceId], actor_id: `owner-${suffix}`, roles: ['workspace_owner'] },
    }))
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', title: 'OAuth scope 商品', stock: 1, price: 1 })

    const denied = await mcp({ token, workspaceId: foreignWorkspaceId, method: 'platform.mapping.preflight', params: { input_json: JSON.stringify(mappingInput(product.id)) } })

    expect(denied.status).toBe(403)
    expect(denied.body.error?.code).toMatch(/WORKSPACE|SCOPE|AUTH|FORBIDDEN/u)
    expect(JSON.stringify(denied.body)).not.toContain(product.id)
  })

  it('rejects a listing identity whose platform does not match the mapped product', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workspaceId = `ws_mapping_listing_${suffix}`
    const token = `mapping-listing-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [token]: { workspaces: [workspaceId], actor_id: `owner-${suffix}`, roles: ['workspace_owner'] },
    }))
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: `owner-${suffix}`, displayName: 'Listing identity owner', role: 'workspace_owner', status: 'active', invitedBy: 'platform-mapping-contract' })
    const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `listing-account-${suffix}`, credentialRef: `fixture://${suffix}` })
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, remoteId: `remote-${suffix}`, title: 'listing identity 商品', stock: 1, price: 1 })

    const mismatched = await mcp({ token, workspaceId, method: 'platform.mapping.preflight', params: { input_json: JSON.stringify(mappingInput(product.id, { platform: 'jd' })) } })

    expect(mismatched.status).toBe(409)
    expect(mismatched.body.error?.code).toBe('PLATFORM_SCOPE_MISMATCH')
  })

  it('marks a readback snapshot mismatch non-publishable instead of creating approval', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workspaceId = `ws_mapping_readback_${suffix}`
    const token = `mapping-readback-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [token]: { workspaces: [workspaceId], actor_id: `owner-${suffix}`, roles: ['workspace_owner'] },
    }))
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: `owner-${suffix}`, displayName: 'Readback owner', role: 'workspace_owner', status: 'active', invitedBy: 'platform-mapping-contract' })
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', title: 'readback mismatch 商品', stock: 1, price: 1 })
    const input = mappingInput(product.id, { remoteSnapshotHash: sha(`remote-${suffix}`) })
    input.remoteSnapshot.confirmation = { ...input.remoteSnapshot.confirmation!, remoteSnapshotHash: sha(`readback-after-write-${suffix}`) }

    const result = await mcp<{ publishable: boolean; confirmationValid: boolean; findings: Array<{ code: string }> }>({ token, workspaceId, method: 'platform.mapping.preflight', params: { input_json: JSON.stringify(input) } })

    expect(result.status).toBe(200)
    expect(result.body.error).toBeNull()
    expect(result.body.data?.result).toMatchObject({ publishable: false, confirmationValid: false })
    expect(result.body.data?.result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONFIRMATION_STALE' })]))
  })

  it('keeps a timed-out publish unknown and accepts only an explicit reconcile observation', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workspaceId = `ws_mapping_reconcile_${suffix}`
    const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `reconcile-account-${suffix}`, credentialRef: `fixture://${suffix}` })
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, remoteId: `reconcile-remote-${suffix}`, title: 'reconcile 商品', stock: 1, price: 1 })
    api.service.confirmProductFacts(workspaceId, product.id)
    const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    api.service.selectDirection(task.id, 'A')
    const draft = api.service.createDraft(task.id)
    api.service.approveContent(task.id, draft.id)
    const preview = api.service.preparePublish(task.id)
    const job = api.service.confirmPublish({ workspaceId, taskId: task.id, contentVersionId: draft.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: `reconcile-${suffix}`, accountId: account.id })

    vi.stubEnv('AUTH_ENFORCEMENT', 'off')
    const timedOut = await fetch(`${baseUrl}/v1/publish-jobs/${job.id}/observation`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ source: 'publish', status: { found: false, state: 'unknown', simulated: false, request_id: `timeout-${suffix}` } }),
    }).then(async response => ({ status: response.status, body: await response.json() as Envelope<any> }))
    expect(timedOut.status).toBe(200)
    expect(timedOut.body.data?.result ?? timedOut.body.data).toMatchObject({ state: 'unknown', remoteState: 'unknown' })

    const reconciled = await fetch(`${baseUrl}/v1/publish-jobs/${job.id}/observation`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ source: 'reconcile', status: { found: true, state: 'published', remote_id: `reconcile-remote-${suffix}`, request_id: `reconcile-request-${suffix}`, simulated: false } }),
    }).then(async response => ({ status: response.status, body: await response.json() as Envelope<any> }))
    expect(reconciled.status).toBe(200)
    expect(reconciled.body.data?.result ?? reconciled.body.data).toMatchObject({ state: 'published', remoteState: 'published' })
  })
})
