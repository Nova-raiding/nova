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
    const deps = { repository, body, resolveWorkspace, enforceAccess, actor: () => 'merchant', send: (_res: ServerResponse, status: number, workspaceId: string, value: unknown) => { sent.push({ status, workspaceId, value }) } }
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
