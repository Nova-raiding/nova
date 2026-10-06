import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../../packages/application/src/service.js'
import { handleInternalWorkerRoute } from './http-internal-worker-routes.js'

function request(method = 'POST') {
  return { method } as any
}

function dependencies(overrides: Partial<Parameters<typeof handleInternalWorkerRoute>[3]> = {}) {
  const sent: Array<{ status: number; workspaceId: string; data: unknown }> = []
  const runSupportSlaScan = vi.fn(async (workspaceId: string, limit: number) => ({ workspaceId, checked: 0, planned: 0, recorded: [] }))
  const recordOperationAudit = vi.fn(async () => undefined)
  return {
    sent,
    runSupportSlaScan,
    recordOperationAudit,
    deps: {
      requireWorkerAuthorization: vi.fn(async () => undefined),
      headerRequired: vi.fn((_req: unknown, name: string) => name === 'x-workspace-id' ? 'ws_scan' : ''),
      body: vi.fn(async () => ({})),
      send: vi.fn((_res, status, workspaceId, data) => sent.push({ status, workspaceId, data })),
      runWorkspaceStorageReconciliation: vi.fn(),
      runSupportSlaScan,
      generateSupportSlaMonthlyReport: vi.fn(),
      recordOperationAudit,
      ...overrides,
    } as Parameters<typeof handleInternalWorkerRoute>[3],
  }
}

describe('internal support worker routes', () => {
  it('runs a signed scan request and records the scan receipt', async () => {
    const fixture = dependencies({ body: vi.fn(async () => ({ limit: 25, workspace_id: 'ws_scan' })) })
    const handled = await handleInternalWorkerRoute(request(), {} as any, '/v1/internal/support/sla-scan', fixture.deps)

    expect(handled).toBe(true)
    expect(fixture.runSupportSlaScan).toHaveBeenCalledWith('ws_scan', 25)
    expect(fixture.recordOperationAudit).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws_scan', action: 'support.sla.scan', resourceId: 'ws_scan',
    }))
    expect(fixture.sent[0]).toMatchObject({ status: 200, workspaceId: 'ws_scan' })
  })

  it('fails closed on tenant mismatch and invalid scan limits', async () => {
    const mismatch = dependencies({ body: vi.fn(async () => ({ workspace_id: 'ws_other' })) })
    await expect(handleInternalWorkerRoute(request(), {} as any, '/v1/internal/support/sla-scan', mismatch.deps))
      .rejects.toMatchObject({ code: 'TENANT_SCOPE_DENIED', status: 403 })
    expect(mismatch.runSupportSlaScan).not.toHaveBeenCalled()

    const invalid = dependencies({ body: vi.fn(async () => ({ limit: 0 })) })
    await expect(handleInternalWorkerRoute(request(), {} as any, '/v1/internal/support/sla-scan', invalid.deps))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(invalid.runSupportSlaScan).not.toHaveBeenCalled()
  })

  it('does not invoke support work when worker authorization fails', async () => {
    const unauthorized = dependencies({
      requireWorkerAuthorization: vi.fn(async () => { throw new DomainError('FORBIDDEN', 'worker proof required', 403) }),
    })
    await expect(handleInternalWorkerRoute(request(), {} as any, '/v1/internal/support/sla-scan', unauthorized.deps))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(unauthorized.runSupportSlaScan).not.toHaveBeenCalled()
    expect(unauthorized.recordOperationAudit).not.toHaveBeenCalled()
  })

  it('does not dispatch unsupported methods as internal support routes', async () => {
    const fixture = dependencies()
    await expect(handleInternalWorkerRoute(request('GET'), {} as any, '/v1/internal/support/sla-scan', fixture.deps))
      .resolves.toBe(false)
    expect(fixture.runSupportSlaScan).not.toHaveBeenCalled()
  })
})
