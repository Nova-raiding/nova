import { describe, expect, it } from 'vitest'
import { MemorySupportSlaReportingRepository } from './support-sla-report-repository.js'
import type { SupportSlaMonthlyReport } from '@merchant-marketing/contracts'

const report: SupportSlaMonthlyReport = {
  reportId: 'run_1', workspaceId: 'ws_a', periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z', cutoffAt: '2026-09-03T00:00:00.000Z', policyVersions: [1], calendarVersions: ['business_weekday_utc'], denominator: 1, met: 1, failed: 0, excluded: 0, lateOrUnresolved: 0, checksum: 'a'.repeat(64), ticketResults: [{ ticketId: 'ticket_1', outcome: 'met', terminalAt: '2026-08-10T10:00:00.000Z' }],
}

describe('support SLA reporting repository', () => {
  it('is workspace-scoped and idempotent while rejecting changed report evidence', async () => {
    const repository = new MemorySupportSlaReportingRepository()
    await expect(repository.createReport({ report })).resolves.toEqual(report)
    await expect(repository.createReport({ report })).resolves.toEqual(report)
    await expect(repository.createReport({ report: { ...report, checksum: 'b'.repeat(64) } })).rejects.toThrow('SUPPORT_SLA_REPORT_IMMUTABLE_CONFLICT')
    await expect(repository.getReport({ workspaceId: 'ws_b', reportId: report.reportId })).resolves.toBeUndefined()
  })

  it('keeps correction runs separate and idempotent', async () => {
    const repository = new MemorySupportSlaReportingRepository()
    const correction = { correctionId: 'correction_1', originalReportId: report.reportId, workspaceId: report.workspaceId, reason: '补录迟到事件', sourceChecksum: 'a'.repeat(64), correctedChecksum: 'b'.repeat(64), idempotencyKey: 'support-sla-correction:run_1:b', status: 'pending_review' as const }
    await expect(repository.createCorrection({ correction })).resolves.toEqual(correction)
    await expect(repository.createCorrection({ correction })).resolves.toEqual(correction)
    await expect(repository.createCorrection({ correction: { ...correction, correctedChecksum: 'c'.repeat(64) } })).rejects.toThrow('SUPPORT_SLA_CORRECTION_IMMUTABLE_CONFLICT')
    const decision = { decisionId: 'decision_1', correctionId: correction.correctionId, workspaceId: correction.workspaceId, decision: 'approved' as const, reason: '复核证据完整', actorId: 'ops-admin-1', idempotencyKey: 'decision-key-1', decidedAt: '2026-09-04T00:00:00.000Z' }
    await expect(repository.decideCorrection({ decision })).resolves.toEqual(decision)
    await expect(repository.decideCorrection({ decision })).resolves.toEqual(decision)
    await expect(repository.getCorrectionDecision({ workspaceId: correction.workspaceId, correctionId: correction.correctionId })).resolves.toEqual(decision)
    await expect(repository.decideCorrection({ decision: { ...decision, decision: 'rejected', idempotencyKey: 'decision-key-2' } })).rejects.toThrow('SUPPORT_SLA_CORRECTION_DECISION_IMMUTABLE_CONFLICT')
  })
})
