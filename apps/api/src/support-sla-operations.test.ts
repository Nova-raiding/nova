import { describe, expect, it, vi } from 'vitest'
import { runSupportSlaScan } from './support-sla-operations.js'

const ticket = {
  id: 'ticket-1', revision: 3, status: 'open' as const,
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
})
