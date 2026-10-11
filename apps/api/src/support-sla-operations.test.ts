import { describe, expect, it, vi } from 'vitest'
import { buildWorkspaceSupportSlaMonthlyReport, runSupportSlaScan } from './support-sla-operations.js'

const ticket = {
  id: 'ticket-1', workspaceId: 'ws_scan', revision: 3, status: 'open' as const,
  sla: {
    policy: { version: 4, calendar: 'cn-2026' },
    firstResponseDueAt: '2026-08-31T10:00:00.000Z', firstResponseAt: undefined,
    resolutionDueAt: '2026-12-01T10:00:00.000Z', resolutionAt: undefined,
    state: 'on_track' as const,
  },
}

function repository() {
  const events: any[] = []
  return {
    events,
    list: vi.fn(async () => ({ items: [{ ...ticket }], nextCursor: undefined })),
    listEvents: vi.fn(async () => []),
    recordSlaAction: vi.fn(async (input: any) => {
      const replay = events.find(event => event.idempotencyKey === input.idempotencyKey)
      if (replay) return { ticket, event: replay, replayed: true }
      const event = { idempotencyKey: input.idempotencyKey, payload: { dueAt: input.dueAt } }
      events.push(event)
      return { ticket, event, replayed: false }
    }),
  }
}

function deps(support: any) {
  return {
    support,
    reporting: {} as any,
    alerts: {
      list: vi.fn(async () => []),
      acknowledge: vi.fn(async () => undefined),
      recordNotification: vi.fn(async () => undefined),
      upsert: vi.fn(async (alert: any) => alert),
    } as any,
    notifyAlert: vi.fn(async () => undefined),
  }
}

describe('support SLA scan operations', () => {
  it('fails closed when the support repository is unavailable', async () => {
    await expect(runSupportSlaScan('ws_scan', 100, deps(undefined)))
      .rejects.toMatchObject({ code: 'SUPPORT_REPOSITORY_UNAVAILABLE', status: 503 })
  })

  it('replays the same durable action on a retry without creating another event', async () => {
    const support = repository()
    const first = await runSupportSlaScan('ws_scan', 100, deps(support))
    const second = await runSupportSlaScan('ws_scan', 100, deps(support))

    expect(first.recorded).toEqual([{ ticketId: 'ticket-1', state: 'at_risk', replayed: false }])
    expect(second.recorded).toEqual([{ ticketId: 'ticket-1', state: 'at_risk', replayed: true }])
    expect(support.recordSlaAction).toHaveBeenCalledTimes(2)
    expect(support.events).toHaveLength(1)
  })

  it('fails closed if a repository page contains a ticket from another workspace', async () => {
    const support = repository()
    support.list.mockResolvedValue({ items: [{ ...ticket, workspaceId: 'ws_other' }], nextCursor: undefined })
    const dependencies = deps(support)

    await expect(runSupportSlaScan('ws_scan', 100, dependencies))
      .rejects.toMatchObject({ code: 'TENANT_SCOPE_DENIED', status: 403 })
    expect(support.recordSlaAction).not.toHaveBeenCalled()
    expect(dependencies.alerts.upsert).not.toHaveBeenCalled()
  })

  it('fails closed if report event reads escape the selected workspace or ticket', async () => {
    const support = repository()
    support.listEvents
      .mockResolvedValueOnce([{ workspaceId: 'ws_scan', ticketId: 'ticket_other' }] as any)
      .mockResolvedValueOnce([{ workspaceId: 'ws_other', ticketId: 'ticket-1' }] as any)
    const dependencies = deps(support)
    const createReport = vi.fn()
    dependencies.reporting = { createReport } as any

    const reportInput = {
      workspaceId: 'ws_scan', reportId: 'r1', periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-09-01T00:00:00.000Z', cutoffAt: '2026-09-04T00:00:00.000Z',
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(buildWorkspaceSupportSlaMonthlyReport(reportInput, dependencies))
        .rejects.toMatchObject({ code: 'TENANT_SCOPE_DENIED', status: 403 })
    }
    expect(createReport).not.toHaveBeenCalled()
  })
})
