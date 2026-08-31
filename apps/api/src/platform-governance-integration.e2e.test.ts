import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { evaluatePlatformFieldMapping, type PlatformFieldMappingGateInput } from '../../../packages/application/src/platform-field-mapping-gate.js'

type ApiModule = typeof import('./server.js')
type Envelope<T = unknown> = { data: { result: T } | null; error: { code: string; message: string; details?: Record<string, unknown> } | null }

let api: ApiModule
let baseUrl = ''

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

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

async function call(token: string, workspaceId: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as Envelope<any> }
}

function mappingInput(productId: string): PlatformFieldMappingGateInput {
  const schemaEvidence = { state: 'production_canary' as const, reference: 'evidence://schema', sha256: sha('schema'), capturedAt: '2026-08-29T00:00:00.000Z' }
  const mappingEvidence = { state: 'production_canary' as const, reference: 'evidence://mapping', sha256: sha('mapping'), capturedAt: '2026-08-29T00:00:00.000Z' }
  const input: PlatformFieldMappingGateInput = {
    platform: 'taobao', category: 'apparel',
    schema: { source: 'official', version: 'schema-v1', immutableEvidence: schemaEvidence, fields: [{ name: 'title', scope: 'product', required: true, type: 'string' }] },
    mapping: { version: 'mapping-v1', schemaVersion: 'schema-v1', immutableEvidence: mappingEvidence, rules: [{ scope: 'product', sourceField: 'name', targetField: 'title' }] },
    source: { productId, productFields: { name: '耐用通勤包' }, skuPages: [{ items: [{ skuId: 'sku-1', fields: {} }] }] },
    remoteSnapshot: { hash: sha('remote-v1'), schemaVersion: 'schema-v1' },
  }
  const preview = evaluatePlatformFieldMapping(input)
  input.remoteSnapshot.confirmation = { id: 'confirm-v1', schemaVersion: input.schema.version, schemaEvidenceHash: schemaEvidence.sha256, mappingVersion: input.mapping.version, mappingEvidenceHash: mappingEvidence.sha256, payloadHash: preview.mappedPayloadHash, remoteSnapshotHash: input.remoteSnapshot.hash, confirmedBy: 'publisher', confirmedAt: '2026-08-29T00:00:00.000Z' }
  return input
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'platform-governance-e2e-session-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('REQUIRE_PLATFORM_GOVERNANCE_GATES', 'true')
  api = await import('./server.js')
  baseUrl = await startServer()
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('platform governance integrations over the real MCP HTTP route', () => {
  it('uses strict platform_ops mutations while non-operator platform readers see active specs only', async () => {
    const suffix = randomUUID().slice(0, 8)
    const wsA = `ws_media_a_${suffix}`
    const wsB = `ws_media_b_${suffix}`
    const tokens = { ops: `ops-${suffix}`, merchantA: `merchant-a-${suffix}`, readerA: `reader-a-${suffix}`, readerB: `reader-b-${suffix}` }
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [tokens.ops]: { workspaces: [wsA], actor_id: `ops-${suffix}`, roles: ['platform_ops'], workbenches: ['platform'] },
      [tokens.merchantA]: { workspaces: [wsA], actor_id: `owner-a-${suffix}`, roles: ['workspace_owner'] },
      [tokens.readerA]: { workspaces: [wsA], actor_id: `reader-a-${suffix}`, roles: ['rules_admin'], workbenches: ['platform'] },
      [tokens.readerB]: { workspaces: [wsB], actor_id: `reader-b-${suffix}`, roles: ['rules_admin'], workbenches: ['platform'] },
    }))
    await api.workspaceMembers.upsert({ workspaceId: wsA, externalSubject: `ops-${suffix}`, displayName: '平台运营', role: 'platform_ops', status: 'active', invitedBy: 'test' })
    await api.workspaceMembers.upsert({ workspaceId: wsA, externalSubject: `owner-a-${suffix}`, displayName: '商家 A', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
    await api.workspaceMembers.upsert({ workspaceId: wsA, externalSubject: `reader-a-${suffix}`, displayName: '规格读者 A', role: 'operator', status: 'active', invitedBy: 'test' })
    await api.workspaceMembers.upsert({ workspaceId: wsB, externalSubject: `reader-b-${suffix}`, displayName: '规格读者 B', role: 'operator', status: 'active', invitedBy: 'test' })

    const denied = await call(tokens.merchantA, wsA, 'platform.media.spec.create', { platform: 'taobao', placement: 'hero', device: 'desktop', version: 'v0', spec_json: '{"width":1}', source_url: 'https://official.example.test/spec', source_sha256: sha('denied-source'), checked_at: new Date(Date.now() - 60_000).toISOString(), expected_revision: '0', idempotency_key: `denied-${suffix}`, reason: '权限验证请求' })
    expect(denied.body.error?.code).toBe('FORBIDDEN')

    const created = await call(tokens.ops, wsA, 'platform.media.spec.create', {
      platform: 'taobao', placement: `detail-hero-${suffix}`, device: 'desktop', version: 'v1',
      spec_json: JSON.stringify({ width: 1200, height: 1200 }), source_url: 'https://official.example.test/media-spec', source_sha256: sha('source'), checked_at: new Date(Date.now() - 60_000).toISOString(),
      evidence_artifact_ref: `evidence://media/${suffix}`, evidence_artifact_sha256: sha('artifact'), expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      expected_revision: '0', idempotency_key: `create-${suffix}`, reason: '上线证据登记',
    })
    expect(created.body.error).toBeNull()
    const spec = created.body.data!.result.spec
    expect(created.body.data!.result.audit).toHaveLength(1)

    for (const [token, workspace] of [[tokens.readerA, wsA], [tokens.readerB, wsB]] as const) {
      const draft = await call(token, workspace, 'platform.media.spec.get', { id: spec.id })
      expect(draft.body.error?.code).toBe('PLATFORM_MEDIA_SPEC_NOT_FOUND')
    }

    const approved = await call(tokens.ops, wsA, 'platform.media.spec.approve', { id: spec.id, expected_revision: '1', idempotency_key: `approve-${suffix}`, reason: '生产证据复核通过' })
    expect(approved.body.data!.result).toMatchObject({ spec: { id: spec.id, status: 'approved', revision: 2 }, audit: [{ eventType: 'created' }, { eventType: 'approved' }] })
    for (const [token, workspace] of [[tokens.readerA, wsA], [tokens.readerB, wsB]] as const) {
      const visible = await call(token, workspace, 'platform.media.spec.list', { platform: 'taobao', placement: `detail-hero-${suffix}` })
      expect(visible.body.data!.result).toMatchObject({ count: 1, visibility: 'active_only', specs: [{ id: spec.id, status: 'approved' }] })
    }

    const stale = await call(tokens.ops, wsA, 'platform.media.spec.expire', { id: spec.id, expected_revision: '1', idempotency_key: `expire-stale-${suffix}`, reason: '过期 revision 验收' })
    expect(stale.body.error?.code).toBe('PLATFORM_MEDIA_SPEC_REVISION_CONFLICT')
    const expired = await call(tokens.ops, wsA, 'platform.media.spec.expire', { id: spec.id, expected_revision: '2', idempotency_key: `expire-${suffix}`, reason: '证据失效下线' })
    expect(expired.body.data!.result.spec.status).toBe('expired')
    expect((await call(tokens.readerB, wsB, 'platform.media.spec.get', { id: spec.id })).body.error?.code).toBe('PLATFORM_MEDIA_SPEC_NOT_FOUND')
  })

  it('persists mapping decisions, rejects unverified/old confirmation, and binds tenant/product scope before publish', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workspaceId = `ws_mapping_${suffix}`
    const otherWorkspace = `ws_mapping_other_${suffix}`
    const token = `mapping-token-${suffix}`
    const otherToken = `mapping-other-${suffix}`
    const ownerToken = `mapping-owner-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [token]: { workspaces: [workspaceId], actor_id: `mapping-reader-${suffix}`, roles: ['workspace_owner'] },
      [otherToken]: { workspaces: [otherWorkspace], actor_id: `mapping-other-${suffix}`, roles: ['workspace_owner'] },
      [ownerToken]: { workspaces: [workspaceId], actor_id: `owner-${suffix}`, roles: ['workspace_owner'] },
    }))
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: `owner-${suffix}`, displayName: '映射所有者', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: `mapping-reader-${suffix}`, displayName: '映射规则读者', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
    await api.workspaceMembers.upsert({ workspaceId: otherWorkspace, externalSubject: `mapping-other-${suffix}`, displayName: '其他租户规则读者', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', title: '映射商品', stock: 1 })
    const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao' })

    const valid = mappingInput(product.id)
    const crossTenant = await call(otherToken, otherWorkspace, 'platform.mapping.preflight', { input_json: JSON.stringify(valid) })
    expect(crossTenant.body.error?.code).toBe('PRODUCT_NOT_FOUND')

    const unverified = structuredClone(valid)
    unverified.schema.immutableEvidence.state = 'unverified'
    const unverifiedResult = await call(token, workspaceId, 'platform.mapping.preflight', { input_json: JSON.stringify(unverified) })
    expect(unverifiedResult.body.error, JSON.stringify(unverifiedResult.body)).toBeNull()
    expect(unverifiedResult.body.data!.result.publishable).toBe(false)
    expect((await call(ownerToken, workspaceId, 'publish.prepare', { task_id: task.id })).body.error?.code).toBe('PLATFORM_MAPPING_PREFLIGHT_REQUIRED')

    vi.stubEnv('ALLOW_FIXTURE_MAPPING_EVIDENCE', 'false')
    const selfAttested = await call(token, workspaceId, 'platform.mapping.preflight', { input_json: JSON.stringify(valid) })
    expect(selfAttested.body.data!.result).toMatchObject({ publishable: false, externallyUnverified: true })
    expect(selfAttested.body.data!.result.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SCHEMA_EXTERNALLY_UNVERIFIED' }),
      expect.objectContaining({ code: 'MAPPING_EXTERNALLY_UNVERIFIED' }),
    ]))
    expect((await call(ownerToken, workspaceId, 'publish.prepare', { task_id: task.id })).body.error?.code).toBe('PLATFORM_MAPPING_PREFLIGHT_REQUIRED')

    vi.stubEnv('ALLOW_FIXTURE_MAPPING_EVIDENCE', 'true')
    const accepted = await call(token, workspaceId, 'platform.mapping.preflight', { input_json: JSON.stringify(valid) })
    expect(accepted.body.data!.result).toMatchObject({ publishable: true, confirmationValid: true, externallyUnverified: false })

    const oldConfirmation = structuredClone(valid)
    oldConfirmation.remoteSnapshot.hash = sha('remote-v2')
    const stale = await call(token, workspaceId, 'platform.mapping.preflight', { input_json: JSON.stringify(oldConfirmation) })
    expect(stale.body.data!.result).toMatchObject({ publishable: false, confirmationValid: false })
    expect(stale.body.data!.result.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONFIRMATION_STALE' })]))
    expect((await call(ownerToken, workspaceId, 'publish.prepare', { task_id: task.id })).body.error?.code).toBe('PLATFORM_MAPPING_PREFLIGHT_REQUIRED')
  })

  it('rejects cross-workspace delivery manifests before parsing or echoing their contents', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workspaceId = `ws_bundle_${suffix}`
    const token = `bundle-token-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: `owner-${suffix}`, roles: ['workspace_owner'] } }))
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: `owner-${suffix}`, displayName: 'Bundle 所有者', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
    const foreignMarker = `foreign-secret-${suffix}`
    const response = await call(token, workspaceId, 'delivery.bundle.verify', {
      manifest_json: JSON.stringify({ scope: { workspaceId: `ws_foreign_${suffix}` }, marker: foreignMarker }),
      files_json: JSON.stringify([{ deliberately: 'malformed-and-must-not-be-parsed' }]),
      expected_manifest_hash: sha('manifest'),
    })
    expect(response.status).toBe(403)
    expect(response.body.error).toMatchObject({ code: 'TENANT_SCOPE_DENIED' })
    expect(JSON.stringify(response.body)).not.toContain(foreignMarker)
  })
})
