import { describe, expect, it } from 'vitest'
import { createSupportSlaProjection } from '../../contracts/src/ops/support-sla.js'
import { planSupportSlaReportSchedule, planSupportSlaScan } from './support-sla-scan.js'

describe('support SLA scan planner', () => {
  it('plans only due at-risk/breach actions and skips paused or terminal tickets', () => {
    const due = createSupportSlaProjection('urgent', new Date('2026-08-31T09:00:00.000Z'))
    const tickets = [
      { workspaceId: 'ws-b', ticketId: 'breach', status: 'in_progress' as const, sla: { ...due, resolutionDueAt: '2026-08-30T17:00:00.000Z', state: 'breached' as const } },
      { workspaceId: 'ws-a', ticketId: 'risk', status: 'open' as const, sla: { ...due, state: 'on_track' as const } },
      { workspaceId: 'ws-a', ticketId: 'paused', status: 'waiting_customer' as const, sla: { ...due, state: 'breached' as const } },
      { workspaceId: 'ws-a', ticketId: 'closed', status: 'closed' as const, sla: { ...due, state: 'breached' as const } },
    ]
    expect(planSupportSlaScan(tickets, new Date('2026-08-31T12:00:00.000Z'))).toEqual([
      expect.objectContaining({ workspaceId: 'ws-a', ticketId: 'risk', state: 'at_risk', idempotencyKey: expect.stringContaining(':at_risk:') }),
      expect.objectContaining({ workspaceId: 'ws-b', ticketId: 'breach', state: 'breached', idempotencyKey: expect.stringContaining(':breached:') }),
    ])
  })

  it('does not create an action before its deadline and stays deterministic', () => {
    const sla = createSupportSlaProjection('urgent', new Date('2026-08-31T09:00:00.000Z'))
    const ticket = { workspaceId: 'ws-a', ticketId: 'ticket-1', status: 'open' as const, sla: { ...sla, state: 'breached' as const } }
    expect(planSupportSlaScan([ticket], new Date('2026-08-31T09:01:00.000Z'))).toEqual([])
    const first = planSupportSlaScan([ticket], new Date('2026-09-01T00:00:00.000Z'))
    const second = planSupportSlaScan([ticket], new Date('2026-09-01T01:00:00.000Z'))
    expect(second).toEqual(first)
  })

  it('re-evaluates a stale cached state at scan time', () => {
    const sla = createSupportSlaProjection('urgent', new Date('2026-08-31T09:00:00.000Z'))
    const ticket = { workspaceId: 'ws-a', ticketId: 'ticket-2', status: 'open' as const, sla }
    expect(planSupportSlaScan([ticket], new Date('2026-08-31T12:00:00.000Z'))).toEqual([
      expect.objectContaining({ state: 'at_risk', ticketId: 'ticket-2' }),
    ])
  })

  it('deduplicates replayed rows without emitting duplicate durable actions', () => {
    const sla = createSupportSlaProjection('urgent', new Date('2026-08-31T09:00:00.000Z'))
    const ticket = { workspaceId: 'ws-a', ticketId: 'ticket-duplicate', status: 'open' as const, sla }
    expect(planSupportSlaScan([ticket, { ...ticket }], new Date('2026-08-31T12:00:00.000Z'))).toHaveLength(1)
  })

  it('fails closed when duplicate rows disagree about the SLA projection', () => {
    const sla = createSupportSlaProjection('urgent', new Date('2026-08-31T09:00:00.000Z'))
    const ticket = { workspaceId: 'ws-a', ticketId: 'ticket-conflict', status: 'open' as const, sla }
    const conflicting = { ...ticket, sla: { ...sla, resolutionDueAt: '2026-08-31T10:00:00.000Z' } }
    expect(planSupportSlaScan([ticket, conflicting], new Date('2026-08-31T12:00:00.000Z'))).toEqual([])
  })

  it('schedules the previous month only after its third business-day cutoff', () => {
    expect(planSupportSlaReportSchedule(new Date('2026-09-02T23:59:59.000Z'))).toBeUndefined()
    expect(planSupportSlaReportSchedule(new Date('2026-09-03T00:00:00.000Z'))).toEqual({
      periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z', cutoffAt: '2026-09-03T00:00:00.000Z', reportId: 'support-sla:2026-08-01T00:00:00.000Z:2026-09-01T00:00:00.000Z',
    })
  })
})
