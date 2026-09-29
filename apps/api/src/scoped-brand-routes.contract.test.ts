import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { MerchantService } from '../../../packages/application/src/service.js'
import { ScopedBrandRevisionConflictError, type PostgresScopedBrandSettingsRepository } from '../../../packages/persistence/src/scoped-brand-settings-repository.js'
import { routeScopedBrandHttp } from './http-scoped-brand-routes.js'
import { hydrateScopedBrandForTask } from './scoped-brand-task-hydration.js'
import { handleMcpTaskContinuation, type McpTaskContinuationDependencies } from './mcp-task-continuation-handlers.js'

const request = (method: string) => ({ method }) as IncomingMessage
const response = () => ({} as ServerResponse)

describe('scoped brand HTTP and task confirmation contracts', () => {
  it('keeps brand scope routes closed and old task confirmation usable on schema 254', async () => {
    const read = vi.fn(async () => ({ schemaVersion: 1 }))
    const deps = {
      repository: undefined,
      body: vi.fn(async () => ({})),
      resolveWorkspace: vi.fn(() => 'ws_demo'),
      enforceAccess: vi.fn(async () => undefined),
      requireActionableStore: vi.fn(),
      actor: () => 'merchant',
      send: vi.fn(),
    }
    for (const [method, path] of [['GET', '/v1/brand-scopes'], ['PUT', '/v1/brand-scopes'], ['POST', '/v1/brand-scopes/series'], ['PUT', '/v1/brand-scopes/assets/asset_1/assignment']]) {
      await expect(routeScopedBrandHttp(request(method!), response(), path!, deps)).rejects.toMatchObject({ code: 'BRAND_SCOPES_NOT_CONFIGURED', status: 503 })
    }
    expect(deps.body).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A', task.version)
    const confirmed = await handleMcpTaskContinuation('task.plan.confirm', { task_id: task.id }, request('POST'), 'ws_demo', {
      service,
      required: (params, name) => String(params[name]),
      scopeTask: () => service.tasks.get(task.id)!,
      taskWriteBrandForProduct: async () => undefined,
      supportedPlatforms: ['taobao'],
      assertCanonicalTaskScopeForAction: async () => undefined,
      resolveCanonicalTaskScope: async () => undefined,
      persistSnapshot: async () => undefined,
      persistEvent: async () => undefined,
      requestActor: () => 'merchant',
      hydrateDurableRuleSnapshot: read,
      recordOperationAudit: async () => undefined,
    }) as typeof task
    expect(confirmed.state).toBe('plan_confirmed')
    expect(confirmed.inputSnapshot?.scopedBrand).toBeUndefined()
  })

  it('enforces the tenant permission before reading or writing and maps CAS conflicts to HTTP 409', async () => {
    const get = vi.fn(async () => undefined)
    const save = vi.fn(async () => { throw new ScopedBrandRevisionConflictError() })
    const repository = { get, save, listSeries: vi.fn(async () => []), listAssetAssignments: vi.fn(async () => []) } as unknown as PostgresScopedBrandSettingsRepository
    const sent: unknown[] = []
    const body = vi.fn(async () => ({ workspace_id: 'other', expected_revision: 2, settings: { schemaVersion: 1 } }))
    const resolveWorkspace = vi.fn((_req: IncomingMessage, id?: unknown) => typeof id === 'string' ? id : 'tenant')
    const enforceAccess = vi.fn(async (_req: IncomingMessage, workspaceId: string) => {
      if (workspaceId !== 'tenant') throw new Error('TENANT_DENIED')
    })
    const deps = { repository, body, resolveWorkspace, enforceAccess, requireActionableStore: vi.fn(), actor: () => 'merchant', send: (_res: ServerResponse, status: number, workspaceId: string, value: unknown) => { sent.push({ status, workspaceId, value }) } }
    await expect(routeScopedBrandHttp(request('PUT'), response(), '/v1/brand-scopes', deps)).rejects.toThrow('TENANT_DENIED')
    expect(save).not.toHaveBeenCalled()
    body.mockResolvedValueOnce({ workspace_id: 'tenant', expected_revision: 2, settings: { schemaVersion: 1 } })
    await expect(routeScopedBrandHttp(request('PUT'), response(), '/v1/brand-scopes', deps)).rejects.toMatchObject({ status: 409 })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'tenant', expectedRevision: 2 }))
    expect(sent).toEqual([])
    expect(await routeScopedBrandHttp(request('GET'), response(), '/v1/brand-scopes', deps)).toBe(true)
    expect(sent).toEqual([{ status: 200, workspaceId: 'tenant', value: expect.objectContaining({ revision: 0, assignments: [], series: [] }) }])
    expect(get).toHaveBeenCalledWith('tenant')
  })

  it.each(['refresh_required', 'revoked'] as const)('rejects %s stores at every scoped brand write and task freeze', async tokenState => {
    const workspaceId = 'ws_demo'
    const service = new MerchantService({ fixtureMode: true })
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'scoped-store', credentialRef: 'vault://scoped-store' })
    const task = service.createTask({ workspaceId, productId: 'prod_fixture_1', platform: 'taobao', accountId: account.id })
    account.tokenState = tokenState
    const repository = {
      save: vi.fn(), createSeries: vi.fn(), assignAsset: vi.fn(), resolveForTask: vi.fn(),
      getAssetAssignment: vi.fn(async () => ({ assetId: 'asset_1', accountId: account.id, seriesId: null, revision: 1 })),
      get: vi.fn(async () => ({ settings: { schemaVersion: 1, stores: { [account.id]: { enabled: true, values: { persona: '旧配置' } } } }, revision: 1 })),
      listSeries: vi.fn(async () => []), listAssetAssignments: vi.fn(async () => []),
    } as unknown as PostgresScopedBrandSettingsRepository
    let payload: Record<string, unknown> = {}
    const deps = {
      repository, body: async () => payload, resolveWorkspace: () => workspaceId,
      enforceAccess: async () => undefined,
      requireActionableStore: (scope: string, accountId: string) => { service.getActionablePlatformAccount(scope, accountId) },
      actor: () => 'merchant', send: vi.fn(),
    }
    payload = { expected_revision: 0, settings: { schemaVersion: 1, stores: { [account.id]: { enabled: true, values: {} } } } }
    await expect(routeScopedBrandHttp(request('PUT'), response(), '/v1/brand-scopes', deps)).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_REAUTH_REQUIRED', status: 409 })
    payload = { expected_revision: 1, settings: { schemaVersion: 1, images: { asset_1: { enabled: true, values: {} } } } }
    await expect(routeScopedBrandHttp(request('PUT'), response(), '/v1/brand-scopes', deps)).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_REAUTH_REQUIRED', status: 409 })
    payload = { account_id: account.id, name: '秋冬系列' }
    await expect(routeScopedBrandHttp(request('POST'), response(), '/v1/brand-scopes/series', deps)).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_REAUTH_REQUIRED', status: 409 })
    payload = { account_id: account.id, expected_revision: 0 }
    await expect(routeScopedBrandHttp(request('PUT'), response(), '/v1/brand-scopes/assets/asset_1/assignment', deps)).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_REAUTH_REQUIRED', status: 409 })
    await expect(hydrateScopedBrandForTask({ workspaceId, task, service, repository, requireRepository: true })).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_REAUTH_REQUIRED', status: 409 })
    expect(repository.save).not.toHaveBeenCalled()
    expect(repository.createSeries).not.toHaveBeenCalled()
    expect(repository.assignAsset).not.toHaveBeenCalled()
    expect(repository.resolveForTask).not.toHaveBeenCalled()
    expect(await routeScopedBrandHttp(request('GET'), response(), '/v1/brand-scopes', deps)).toBe(true)
    expect(deps.send).toHaveBeenCalledWith(expect.anything(), 200, workspaceId, expect.objectContaining({ revision: 1 }), null, expect.anything())
  })

  it('lets an active store change while retaining an unchanged revoked store entry', async () => {
    const workspaceId = 'ws_demo'
    const service = new MerchantService({ fixtureMode: true })
    const inactive = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'old', credentialRef: 'vault://old' })
    const active = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'current', credentialRef: 'vault://current' })
    inactive.tokenState = 'revoked'
    const oldEntry = { enabled: true, values: { persona: '旧店资料' } }
    const settings = { schemaVersion: 1, stores: { [inactive.id]: oldEntry, [active.id]: { enabled: true, values: { persona: '新店资料' } } } }
    const save = vi.fn(async () => ({ settings, revision: 2 }))
    const repository = { get: vi.fn(async () => ({ settings: { schemaVersion: 1, stores: { [inactive.id]: oldEntry } }, revision: 1 })), save } as unknown as PostgresScopedBrandSettingsRepository
    const checked: string[] = []
    const deps = {
      repository, body: async () => ({ expected_revision: 1, settings }), resolveWorkspace: () => workspaceId,
      enforceAccess: async () => undefined,
      requireActionableStore: (scope: string, accountId: string) => { checked.push(accountId); service.getActionablePlatformAccount(scope, accountId) },
      actor: () => 'merchant', send: vi.fn(),
    }
    await expect(routeScopedBrandHttp(request('PUT'), response(), '/v1/brand-scopes', deps)).resolves.toBe(true)
    expect(checked).toEqual([active.id])
    expect(save).toHaveBeenCalledOnce()
    const task = service.createTask({ workspaceId, productId: 'prod_fixture_1', platform: 'taobao', accountId: active.id })
    const taskRepository = { resolveForTask: vi.fn(async () => ({ settings, revision: 2, context: { accountId: active.id } })) } as unknown as PostgresScopedBrandSettingsRepository
    await expect(hydrateScopedBrandForTask({ workspaceId, task, service, repository: taskRepository, requireRepository: true })).resolves.toBeUndefined()
    expect(taskRepository.resolveForTask).toHaveBeenCalledOnce()
  })

  it('allows a manual store only while manual operations mode is active', async () => {
    let manualMode = true
    const service = new MerchantService({ fixtureMode: true, manualStoreRecords: () => manualMode })
    const account = service.registerManualPlatformAccount({ workspaceId: 'ws_demo', platform: 'taobao', remoteAccountId: 'manual-store' })
    const settings = { schemaVersion: 1, stores: { [account.id]: { enabled: true, values: {} } } }
    const save = vi.fn(async () => ({ settings, revision: 1 }))
    const repository = { get: vi.fn(async () => undefined), save } as unknown as PostgresScopedBrandSettingsRepository
    const deps = {
      repository, body: async () => ({ expected_revision: 0, settings }), resolveWorkspace: () => 'ws_demo',
      enforceAccess: async () => undefined,
      requireActionableStore: (workspaceId: string, accountId: string) => { service.getActionablePlatformAccount(workspaceId, accountId) },
      actor: () => 'merchant', send: vi.fn(),
    }
    await expect(routeScopedBrandHttp(request('PUT'), response(), '/v1/brand-scopes', deps)).resolves.toBe(true)
    expect(save).toHaveBeenCalledOnce()
    manualMode = false
    await expect(routeScopedBrandHttp(request('PUT'), response(), '/v1/brand-scopes', deps)).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_REAUTH_REQUIRED', status: 409 })
    expect(save).toHaveBeenCalledOnce()
  })

  it('hydrates tenant-checked settings before the real task.plan.confirm and freezes the revision', async () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A', task.version)
    const resolveForTask = vi.fn(async () => ({ revision: 3, context: { accountId: 'store_1' }, settings: { schemaVersion: 1 as const, global: { enabled: true, values: { persona: '已保存受众' } } } }))
    const repository = { resolveForTask } as unknown as PostgresScopedBrandSettingsRepository
    const hydrate = (workspaceId: string, currentTask: typeof task) => hydrateScopedBrandForTask({ workspaceId, task: currentTask, service, repository, requireRepository: true })
    await expect(hydrate('other', task)).rejects.toMatchObject({ status: 403 })
    expect(resolveForTask).not.toHaveBeenCalled()
    const req = request('POST')
    const deps: McpTaskContinuationDependencies = {
      service,
      required: (params, name) => String(params[name]),
      scopeTask: (_req, id) => { if (id !== task.id) throw new Error('TASK_DENIED'); return service.tasks.get(id)! },
      taskWriteBrandForProduct: async () => undefined,
      supportedPlatforms: ['taobao'],
      assertCanonicalTaskScopeForAction: async () => undefined,
      resolveCanonicalTaskScope: async () => undefined,
      persistSnapshot: async () => undefined,
      persistEvent: async () => undefined,
      requestActor: () => 'merchant',
      hydrateDurableRuleSnapshot: async () => undefined,
      hydrateScopedBrandForTask: hydrate,
      recordOperationAudit: async () => undefined,
    }
    const confirmed = await handleMcpTaskContinuation('task.plan.confirm', { task_id: task.id }, req, 'ws_demo', deps) as typeof task
    expect(resolveForTask).toHaveBeenCalledOnce()
    expect(confirmed.inputSnapshot?.scopedBrand).toMatchObject({ revision: 3, values: { persona: '已保存受众' } })
    await expect(hydrate('ws_demo', confirmed)).rejects.toMatchObject({ code: 'BRAND_SCOPE_FROZEN' })
  })
})
