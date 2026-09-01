import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ConnectorRuntime } from '../../../packages/application/src/connector-runtime.js'
import { hashPlatformMappedPayload } from '../../../packages/application/src/platform-field-mapping-gate.js'
import type { StoredMappingPreflightApproval } from '../../../packages/persistence/src/mapping-preflight-approval-repository.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import {
  createPersistentWorkerMappingPreflightAdapter,
  createPostgresWorkerMappingScopeLoader,
  WorkerMappingExecutionContext,
  type WorkerMappingScope,
} from './mapping-preflight-adapter.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const fields = { title: '已审批商品', description: '真实发布字段', category: 'apparel', price: 199, stock: 8 }
const scope: WorkerMappingScope = {
  workspaceId: 'ws_a', taskId: 'task_a', productId: 'product_a', productVersion: 7,
  platform: 'jd', accountId: 'acct_a', category: 'apparel',
}

function approval(overrides: Partial<StoredMappingPreflightApproval> = {}): StoredMappingPreflightApproval {
  return {
    workspaceId: scope.workspaceId,
    platform: scope.platform,
    productId: scope.productId,
    productVersion: scope.productVersion,
    mappedPayloadHash: hashPlatformMappedPayload({
      productId: scope.productId,
      category: scope.category,
      product: fields,
      skus: [{ sourceSkuId: `product:${scope.productId}`, fields: {} }],
    }),
    remoteSnapshotHash: digest('remote'),
    schemaVersion: 'jd-schema-v7',
    schemaEvidenceHash: digest('schema'),
    mappingVersion: 'jd-mapping-v7',
    mappingEvidenceHash: digest('mapping'),
    publishable: true,
    confirmationValid: true,
    externallyUnverified: false,
    findingCodes: [],
    evaluatedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-08-29T01:00:00.000Z',
    createdBy: 'platform-ops',
    revision: 3,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  }
}

function event(overrides: Partial<DurableOutboxEvent> = {}): DurableOutboxEvent {
  return {
    id: 'evt_a', workspaceId: scope.workspaceId, aggregateId: 'publish_a', eventType: 'publish.requested', sequence: 1,
    payload: { taskId: scope.taskId, workspaceId: scope.workspaceId, platform: scope.platform, account_id: scope.accountId, remote_id: 'JD-100', fields },
    createdAt: '2026-08-29T00:01:00.000Z',
    ...overrides,
  }
}

function harness(input: { get?: () => Promise<StoredMappingPreflightApproval | undefined>; resolveActive?: () => Promise<StoredMappingPreflightApproval | undefined>; load?: () => Promise<WorkerMappingScope | undefined> } = {}) {
  const current = approval()
  const get = vi.fn(input.get ?? (async () => current))
  const resolveActive = vi.fn(input.resolveActive ?? (async () => current))
  const load = vi.fn(input.load ?? (async () => scope))
  const execution = new WorkerMappingExecutionContext()
  const adapter = createPersistentWorkerMappingPreflightAdapter({ approvals: { get, resolveActive }, scopes: { load }, execution })
  return { adapter, execution, get, resolveActive, load }
}

const request = () => ({
  platform: scope.platform,
  context: { workspaceId: scope.workspaceId, accountId: scope.accountId, traceId: 'evt_a' },
  fields,
  remoteId: 'JD-100',
  operation: 'update' as const,
})

const runWrite = (h: ReturnType<typeof harness>, durableEvent: DurableOutboxEvent, writeRequest = request()) =>
  h.execution.run(durableEvent, async () => await h.adapter.write!(writeRequest))

describe('persistent worker mapping preflight adapter', () => {
  it('injects durable approval into the real ConnectorRuntime and rereads the tenant-scoped repository', async () => {
    const { adapter, execution, get, resolveActive } = harness()
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true, environment: 'test', mappingPreflight: adapter })

    const result = await execution.run(event(), () => runtime.executePublish({
      platform: scope.platform,
      context: request().context,
      fields,
      remoteId: 'JD-100',
      idempotencyKey: 'publish-idem-a',
    }))

    expect(result.receipt).toMatchObject({ platform: 'jd', operation: 'update', remoteId: 'JD-100' })
    expect(get).toHaveBeenCalledWith({ workspaceId: 'ws_a', platform: 'jd', productId: 'product_a' })
    expect(resolveActive).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_a', productId: 'product_a', productVersion: 7, mappedPayloadHash: approval().mappedPayloadHash }))
  })

  it('fails closed without a durable event and for create operations', async () => {
    const { adapter, execution, get } = harness()
    await expect(adapter.write!(request())).rejects.toMatchObject({ normalized: { code: 'MAPPING_PREFLIGHT_CONTEXT_MISSING', retryable: false, unknown: false } })
    await expect(execution.run(event({ payload: { ...event().payload, remote_id: undefined } }), async () => await adapter.write!({ ...request(), remoteId: undefined, operation: 'create' }))).rejects.toMatchObject({
      normalized: { code: 'MAPPING_PREFLIGHT_OPERATION_MISMATCH', retryable: false, unknown: false },
    })
    expect(get).not.toHaveBeenCalled()
  })

  it('rejects cross-tenant, cross-account, and persisted scope mismatches before approval lookup', async () => {
    const crossTenant = harness()
    await expect(runWrite(crossTenant, event(), { ...request(), context: { ...request().context, workspaceId: 'ws_b' } })).rejects.toMatchObject({ normalized: { code: 'MAPPING_PREFLIGHT_SCOPE_MISMATCH' } })

    const crossAccount = harness()
    await expect(runWrite(crossAccount, event(), { ...request(), context: { ...request().context, accountId: 'acct_b' } })).rejects.toMatchObject({ normalized: { code: 'MAPPING_PREFLIGHT_SCOPE_MISMATCH' } })

    const wrongPersistedTenant = harness({ load: async () => ({ ...scope, workspaceId: 'ws_b' }) })
    await expect(runWrite(wrongPersistedTenant, event())).rejects.toMatchObject({ normalized: { code: 'MAPPING_PREFLIGHT_SCOPE_MISMATCH' } })
    expect(wrongPersistedTenant.get).not.toHaveBeenCalled()
  })

  it('binds the approval hash to the exact durable payload and rejects unsupported structures', async () => {
    const stale = harness({ get: async () => approval({ mappedPayloadHash: digest('old-payload') }) })
    await expect(runWrite(stale, event())).rejects.toMatchObject({ normalized: { code: 'MAPPING_PREFLIGHT_PAYLOAD_MISMATCH' } })
    expect(stale.resolveActive).not.toHaveBeenCalled()

    const structuredFields = { ...fields, attributes: { material: 'cotton' } }
    const unsupported = harness()
    await expect(runWrite(unsupported, event({ payload: { ...event().payload, fields: structuredFields } }), { ...request(), fields: structuredFields })).rejects.toMatchObject({
      normalized: { code: 'MAPPING_PREFLIGHT_PAYLOAD_UNSUPPORTED', retryable: false, unknown: false },
    })
  })

  it('recovers after a persistence disconnect by rereading scope and approval with no process cache', async () => {
    let attempts = 0
    const connected = approval()
    const h = harness({
      get: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('connection terminated')
        return connected
      },
    })

    await expect(runWrite(h, event())).rejects.toMatchObject({
      normalized: { code: 'MAPPING_PREFLIGHT_PERSISTENCE_UNAVAILABLE', retryable: true, unknown: false },
    })
    await expect(runWrite(h, event())).resolves.toBeDefined()
    expect(h.load).toHaveBeenCalledTimes(2)
    expect(h.get).toHaveBeenCalledTimes(2)
  })

  it('treats expired or revoked approval resolution as a deterministic block', async () => {
    const h = harness({ resolveActive: async () => undefined })
    await expect(runWrite(h, event())).rejects.toMatchObject({
      normalized: { code: 'MAPPING_PREFLIGHT_REQUIRED', retryable: false, unknown: false },
    })
  })
})

describe('postgres worker mapping scope loader', () => {
  it('sets tenant RLS context and loads task, product, account, platform, and version atomically', async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => ({ rows: sql.includes('FROM tasks task') ? [{ ...scope }] : [], rowCount: 1, command: '', oid: 0, fields: [] }))
    const release = vi.fn()
    const loader = createPostgresWorkerMappingScopeLoader({ connect: async () => ({ query, release }) } as never)

    await expect(loader.load({ workspaceId: 'ws_a', taskId: 'task_a' })).resolves.toEqual(scope)
    expect(query.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['BEGIN', "SELECT set_config('app.workspace_id', $1, true)", 'COMMIT']))
    expect(query).toHaveBeenCalledWith("SELECT set_config('app.workspace_id', $1, true)", ['ws_a'])
    expect(query.mock.calls.find(call => String(call[0]).includes('FROM tasks task'))?.[1]).toEqual(['ws_a', 'task_a'])
    expect(release).toHaveBeenCalledOnce()
  })

  it('rolls back and releases the connection when the tenant-scoped query disconnects', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM tasks task')) throw new Error('server closed the connection unexpectedly')
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] }
    })
    const release = vi.fn()
    const loader = createPostgresWorkerMappingScopeLoader({ connect: async () => ({ query, release }) } as never)

    await expect(loader.load({ workspaceId: 'ws_a', taskId: 'task_a' })).rejects.toThrow('server closed the connection unexpectedly')
    expect(query).toHaveBeenCalledWith('ROLLBACK')
    expect(release).toHaveBeenCalledOnce()
  })
})
