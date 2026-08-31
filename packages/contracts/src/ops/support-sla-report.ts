import { createHash } from 'node:crypto'
import { projectSupportSlaFromEvents, supportSlaReportCutoffAt, type SupportSlaEventLike, type SupportSlaProjection } from './support-sla.js'

export type SupportSlaReportExclusion = 'contract_na' | 'merged_duplicate_before_first_response' | 'test_ticket'

export interface SupportSlaReportTicket {
  workspaceId: string
  ticketId: string
  sla: SupportSlaProjection
  events: readonly SupportSlaEventLike[]
  exclusion?: SupportSlaReportExclusion
}

export interface SupportSlaMonthlyReport {
  reportId: string
  workspaceId: string
  periodStart: string
  periodEnd: string
  cutoffAt: string
  policyVersions: number[]
  calendarVersions: string[]
  denominator: number
  met: number
  failed: number
  excluded: number
  lateOrUnresolved: number
  checksum: string
  ticketResults: Array<{ ticketId: string; outcome: 'met' | 'failed' | 'excluded'; terminalAt?: string; exclusion?: SupportSlaReportExclusion }>
}

export interface SupportSlaCorrectionRun {
  correctionId: string
  originalReportId: string
  workspaceId: string
  reason: string
  sourceChecksum: string
  correctedChecksum: string
  idempotencyKey: string
  status: 'pending_review'
}

export interface SupportSlaCorrectionDecision {
  decisionId: string
  correctionId: string
  workspaceId: string
  decision: 'approved' | 'rejected'
  reason: string
  actorId: string
  idempotencyKey: string
  decidedAt: string
}

export interface SupportSlaCorrectionApproval {
  approvalId: string
  correctionId: string
  workspaceId: string
  decision: 'approved' | 'rejected'
  reason: string
  actorId: string
  idempotencyKey: string
  approvedAt: string
}

export interface SupportSlaCorrectionApprovalProgress {
  status: 'pending_approval'
  correctionId: string
  workspaceId: string
  approvals: SupportSlaCorrectionApproval[]
  requiredApprovals: 2
}

const isoTime = (value: string, field: string) => {
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new RangeError(`SUPPORT_SLA_REPORT_${field.toUpperCase()}_INVALID`)
  return time
}

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

const checksum = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

function terminalAt(ticket: SupportSlaReportTicket, periodStart: number, periodEnd: number): string | undefined {
  const event = ticket.events
    .filter(item => item.eventType === 'status_changed' && ['resolved', 'closed'].includes(String(item.payload.to)))
    .filter(item => { const time = Date.parse(item.createdAt); return Number.isFinite(time) && time >= periodStart && time < periodEnd })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  return event?.createdAt
}

/** Builds a deterministic, read-only monthly SLA result from immutable events. */
export function buildSupportSlaMonthlyReport(input: {
  reportId: string
  workspaceId: string
  periodStart: string
  periodEnd: string
  cutoffAt: string
  tickets: readonly SupportSlaReportTicket[]
}): SupportSlaMonthlyReport {
  const start = isoTime(input.periodStart, 'period_start')
  const end = isoTime(input.periodEnd, 'period_end')
  isoTime(input.cutoffAt, 'cutoff_at')
  if (input.cutoffAt !== supportSlaReportCutoffAt(input.periodEnd)) throw new RangeError('SUPPORT_SLA_REPORT_CUTOFF_INVALID')
  if (end <= start) throw new RangeError('SUPPORT_SLA_REPORT_PERIOD_INVALID')
  const ticketResults: SupportSlaMonthlyReport['ticketResults'] = []
  const policyVersions = new Set<number>()
  const calendars = new Set<string>()
  for (const ticket of input.tickets.filter(item => item.workspaceId === input.workspaceId)) {
    policyVersions.add(ticket.sla.policy.version)
    calendars.add(ticket.sla.policy.calendar)
    if (ticket.exclusion) {
      ticketResults.push({ ticketId: ticket.ticketId, outcome: 'excluded', exclusion: ticket.exclusion })
      continue
    }
    const terminal = terminalAt(ticket, start, end)
    const projectedAt = terminal ? new Date(terminal) : new Date(end)
    // Historical reports are evaluated at the period boundary. Events that
    // arrive later belong to a correction run; allowing them into this
    // projection would make a previously persisted report depend on future
    // activity (for example, a later reopen could erase `resolvedAt`).
    const periodEvents = ticket.events.filter(event => {
      const time = Date.parse(event.createdAt)
      return Number.isFinite(time) && time < end
    })
    const projected = projectSupportSlaFromEvents(ticket.sla, periodEvents, projectedAt)
    // A terminal ticket is reportable in the month; an unfinished ticket is
    // reportable only when its clock had expired by the reporting period end.
    const reportableUnresolved = !terminal && Date.parse(projected.resolutionDueAt) < end
    if (!terminal && !reportableUnresolved) continue
    const firstResponseMet = Boolean(projected.firstResponseAt) && Date.parse(projected.firstResponseAt!) <= Date.parse(projected.firstResponseDueAt)
    const resolutionMet = Boolean(terminal) && Date.parse(terminal!) <= Date.parse(projected.resolutionDueAt)
    const met = firstResponseMet && resolutionMet
    ticketResults.push({ ticketId: ticket.ticketId, outcome: met ? 'met' : 'failed', ...(terminal ? { terminalAt: terminal } : {}) })
  }
  const met = ticketResults.filter(item => item.outcome === 'met').length
  const failed = ticketResults.filter(item => item.outcome === 'failed').length
  const excluded = ticketResults.filter(item => item.outcome === 'excluded').length
  const payload = { reportId: input.reportId, workspaceId: input.workspaceId, periodStart: input.periodStart, periodEnd: input.periodEnd, cutoffAt: input.cutoffAt, policyVersions: [...policyVersions].sort(), calendarVersions: [...calendars].sort(), ticketResults }
  return { ...payload, denominator: met + failed, met, failed, excluded, lateOrUnresolved: failed, checksum: checksum(payload) }
}

/** A late fact creates a linked correction run; it never overwrites a report. */
export function createSupportSlaCorrectionRun(input: { original: SupportSlaMonthlyReport; corrected: SupportSlaMonthlyReport; correctionId: string; reason: string }): SupportSlaCorrectionRun | undefined {
  if (!input.reason.trim()) throw new RangeError('SUPPORT_SLA_CORRECTION_REASON_REQUIRED')
  if (input.original.checksum === input.corrected.checksum) return undefined
  return { correctionId: input.correctionId, originalReportId: input.original.reportId, workspaceId: input.original.workspaceId, reason: input.reason.trim(), sourceChecksum: input.original.checksum, correctedChecksum: input.corrected.checksum, idempotencyKey: `support-sla-correction:${input.original.reportId}:${input.corrected.checksum}`, status: 'pending_review' }
}
