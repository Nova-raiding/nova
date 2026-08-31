import { describe, expect, it } from 'vitest'
import { buildSupportSlaMonthlyReport, createSupportSlaCorrectionRun } from './support-sla-report.js'
import { createSupportSlaProjection } from './support-sla.js'

const period = { periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z', cutoffAt: '2026-09-03T00:00:00.000Z' }

describe('support SLA monthly report', () => {
  it('counts terminal clocks and unresolved expired clocks without treating pending work as zero', () => {
    const base = createSupportSlaProjection('urgent', new Date('2026-08-03T09:00:00.000Z'))
    const report = buildSupportSlaMonthlyReport({ reportId: 'run_1', workspaceId: 'ws_a', ...period, tickets: [
      { workspaceId: 'ws_a', ticketId: 'met', sla: base, events: [{ eventType: 'commented', payload: { visibility: 'customer' }, createdAt: '2026-08-03T10:00:00.000Z' }, { eventType: 'status_changed', payload: { to: 'resolved' }, createdAt: '2026-08-03T12:00:00.000Z' }] },
      { workspaceId: 'ws_a', ticketId: 'unresolved', sla: createSupportSlaProjection('urgent', new Date('2026-08-03T09:00:00.000Z')), events: [] },
      { workspaceId: 'ws_a', ticketId: 'pending', sla: createSupportSlaProjection('urgent', new Date('2026-08-31T18:00:00.000Z')), events: [] },
      { workspaceId: 'ws_a', ticketId: 'na', sla: base, events: [], exclusion: 'contract_na' },
    ] })
    expect(report).toMatchObject({ denominator: 2, met: 1, failed: 1, excluded: 1, lateOrUnresolved: 1 })
    expect(report.ticketResults).toEqual(expect.arrayContaining([{ ticketId: 'met', outcome: 'met', terminalAt: '2026-08-03T12:00:00.000Z' }, { ticketId: 'unresolved', outcome: 'failed' }, { ticketId: 'na', outcome: 'excluded', exclusion: 'contract_na' }]))
    expect(report.checksum).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('creates a linked correction run only when the immutable result changes', () => {
    const base = createSupportSlaProjection('urgent', new Date('2026-08-03T09:00:00.000Z'))
    const original = buildSupportSlaMonthlyReport({ reportId: 'run_1', workspaceId: 'ws_a', ...period, tickets: [] })
    const corrected = buildSupportSlaMonthlyReport({ reportId: 'run_1', workspaceId: 'ws_a', ...period, tickets: [{ workspaceId: 'ws_a', ticketId: 'late', sla: base, events: [{ eventType: 'commented', payload: { visibility: 'customer' }, createdAt: '2026-08-03T10:00:00.000Z' }, { eventType: 'status_changed', payload: { to: 'resolved' }, createdAt: '2026-08-03T12:00:00.000Z' }] }] })
    const correction = createSupportSlaCorrectionRun({ original, corrected, correctionId: 'correction_1', reason: '补录迟到事件' })
    expect(correction).toMatchObject({ originalReportId: 'run_1', sourceChecksum: original.checksum, correctedChecksum: corrected.checksum, status: 'pending_review' })
    expect(createSupportSlaCorrectionRun({ original, corrected: original, correctionId: 'noop', reason: '无变化' })).toBeUndefined()
  })

  it('does not let events after the reporting period rewrite the historical result', () => {
    const base = createSupportSlaProjection('urgent', new Date('2026-08-03T09:00:00.000Z'))
    const ticket = {
      workspaceId: 'ws_a',
      ticketId: 'reopened_later',
      sla: base,
      events: [
        { eventType: 'commented' as const, payload: { visibility: 'customer' }, createdAt: '2026-08-03T10:00:00.000Z' },
        { eventType: 'status_changed' as const, payload: { to: 'resolved' }, createdAt: '2026-08-03T12:00:00.000Z' },
        { eventType: 'status_changed' as const, payload: { to: 'open' }, createdAt: '2026-09-02T09:00:00.000Z' },
      ],
    }
    const report = buildSupportSlaMonthlyReport({ reportId: 'run_1', workspaceId: 'ws_a', ...period, tickets: [ticket] })
    expect(report.ticketResults).toEqual([{ ticketId: 'reopened_later', outcome: 'met', terminalAt: '2026-08-03T12:00:00.000Z' }])
  })
})
