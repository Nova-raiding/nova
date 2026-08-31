import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'
import type { SupportSlaCorrectionApproval, SupportSlaCorrectionDecision, SupportSlaCorrectionRun, SupportSlaMonthlyReport } from '@merchant-marketing/contracts'

export interface SupportSlaReportingRepository {
  createReport(input: { report: SupportSlaMonthlyReport }): Promise<SupportSlaMonthlyReport>
  getReport(input: { workspaceId: string; reportId: string }): Promise<SupportSlaMonthlyReport | undefined>
  listReports(input: { workspaceId: string; limit?: number }): Promise<SupportSlaMonthlyReport[]>
  createCorrection(input: { correction: SupportSlaCorrectionRun }): Promise<SupportSlaCorrectionRun>
  getCorrection(input: { workspaceId: string; correctionId: string }): Promise<SupportSlaCorrectionRun | undefined>
  decideCorrection(input: { decision: SupportSlaCorrectionDecision }): Promise<SupportSlaCorrectionDecision>
  getCorrectionDecision(input: { workspaceId: string; correctionId: string }): Promise<SupportSlaCorrectionDecision | undefined>
  addCorrectionApproval(input: { approval: SupportSlaCorrectionApproval }): Promise<SupportSlaCorrectionApproval>
  listCorrectionApprovals(input: { workspaceId: string; correctionId: string }): Promise<SupportSlaCorrectionApproval[]>
}

const reportKey = (workspaceId: string, reportId: string) => `${workspaceId}:${reportId}`

export class MemorySupportSlaReportingRepository implements SupportSlaReportingRepository {
  private readonly reports = new Map<string, SupportSlaMonthlyReport>()
  private readonly corrections = new Map<string, SupportSlaCorrectionRun>()
  private readonly decisions = new Map<string, SupportSlaCorrectionDecision>()
  private readonly approvals = new Map<string, SupportSlaCorrectionApproval>()

  async createReport(input: { report: SupportSlaMonthlyReport }) {
    requireWorkspaceScope(input.report.workspaceId)
    const key = reportKey(input.report.workspaceId, input.report.reportId)
    const existing = this.reports.get(key)
    if (existing) {
      if (existing.checksum !== input.report.checksum) throw new Error('SUPPORT_SLA_REPORT_IMMUTABLE_CONFLICT')
      return structuredClone(existing)
    }
    this.reports.set(key, structuredClone(input.report))
    return structuredClone(input.report)
  }

  async getReport(input: { workspaceId: string; reportId: string }) {
    requireWorkspaceScope(input.workspaceId)
    const report = this.reports.get(reportKey(input.workspaceId, input.reportId))
    return report ? structuredClone(report) : undefined
  }

  async listReports(input: { workspaceId: string; limit?: number }) {
    requireWorkspaceScope(input.workspaceId)
    const limit = Math.min(100, Math.max(1, input.limit ?? 50))
    return [...this.reports.values()].filter(report => report.workspaceId === input.workspaceId).sort((a, b) => b.periodStart.localeCompare(a.periodStart) || b.reportId.localeCompare(a.reportId)).slice(0, limit).map(report => structuredClone(report))
  }

  async createCorrection(input: { correction: SupportSlaCorrectionRun }) {
    requireWorkspaceScope(input.correction.workspaceId)
    const key = reportKey(input.correction.workspaceId, input.correction.correctionId)
    const existing = this.corrections.get(key)
    if (existing) {
      if (existing.correctedChecksum !== input.correction.correctedChecksum) throw new Error('SUPPORT_SLA_CORRECTION_IMMUTABLE_CONFLICT')
      return structuredClone(existing)
    }
    this.corrections.set(key, structuredClone(input.correction))
    return structuredClone(input.correction)
  }

  async getCorrection(input: { workspaceId: string; correctionId: string }) {
    requireWorkspaceScope(input.workspaceId)
    const correction = this.corrections.get(reportKey(input.workspaceId, input.correctionId))
    return correction ? structuredClone(correction) : undefined
  }

  async decideCorrection(input: { decision: SupportSlaCorrectionDecision }) {
    requireWorkspaceScope(input.decision.workspaceId)
    const key = reportKey(input.decision.workspaceId, input.decision.correctionId)
    const existing = this.decisions.get(key)
    if (existing) {
      if (existing.idempotencyKey !== input.decision.idempotencyKey) throw new Error('SUPPORT_SLA_CORRECTION_DECISION_IMMUTABLE_CONFLICT')
      return structuredClone(existing)
    }
    this.decisions.set(key, structuredClone(input.decision))
    return structuredClone(input.decision)
  }

  async getCorrectionDecision(input: { workspaceId: string; correctionId: string }) {
    requireWorkspaceScope(input.workspaceId)
    const decision = this.decisions.get(reportKey(input.workspaceId, input.correctionId))
    return decision ? structuredClone(decision) : undefined
  }

  async addCorrectionApproval(input: { approval: SupportSlaCorrectionApproval }) {
    requireWorkspaceScope(input.approval.workspaceId)
    const key = reportKey(input.approval.workspaceId, input.approval.approvalId)
    const existing = this.approvals.get(key)
    if (existing) {
      if (existing.idempotencyKey !== input.approval.idempotencyKey) throw new Error('SUPPORT_SLA_CORRECTION_APPROVAL_IMMUTABLE_CONFLICT')
      return structuredClone(existing)
    }
    if ([...this.approvals.values()].some(item => item.workspaceId === input.approval.workspaceId && item.correctionId === input.approval.correctionId && item.actorId === input.approval.actorId)) throw new Error('SUPPORT_SLA_CORRECTION_APPROVAL_ACTOR_DUPLICATE')
    this.approvals.set(key, structuredClone(input.approval))
    return structuredClone(input.approval)
  }

  async listCorrectionApprovals(input: { workspaceId: string; correctionId: string }) {
    requireWorkspaceScope(input.workspaceId)
    return [...this.approvals.values()].filter(item => item.workspaceId === input.workspaceId && item.correctionId === input.correctionId).sort((a, b) => a.approvedAt.localeCompare(b.approvedAt)).map(item => structuredClone(item))
  }
}

const reportFromRow = (row: Record<string, unknown>): SupportSlaMonthlyReport => ({
  reportId: String(row.reportId), workspaceId: String(row.workspaceId), periodStart: new Date(String(row.periodStart)).toISOString(), periodEnd: new Date(String(row.periodEnd)).toISOString(), cutoffAt: new Date(String(row.cutoffAt)).toISOString(),
  policyVersions: Array.isArray(row.policyVersions) ? row.policyVersions.map(Number) : [], calendarVersions: Array.isArray(row.calendarVersions) ? row.calendarVersions.map(String) : [], denominator: Number(row.denominator), met: Number(row.met), failed: Number(row.failed), excluded: Number(row.excluded), lateOrUnresolved: Number(row.lateOrUnresolved), checksum: String(row.checksum), ticketResults: Array.isArray(row.ticketResults) ? row.ticketResults as SupportSlaMonthlyReport['ticketResults'] : [],
})

export class PostgresSupportSlaReportingRepository implements SupportSlaReportingRepository {
  constructor(private readonly pool: SqlPool) {}

  async createReport(input: { report: SupportSlaMonthlyReport }) {
    const report = input.report
    requireWorkspaceScope(report.workspaceId)
    return withWorkspaceTransaction(this.pool, report.workspaceId, async client => {
      const existing = await client.query<Record<string, unknown>>('SELECT report_id AS "reportId", workspace_id AS "workspaceId", period_start AS "periodStart", period_end AS "periodEnd", cutoff_at AS "cutoffAt", policy_versions_json AS "policyVersions", calendar_versions_json AS "calendarVersions", denominator, met, failed, excluded, late_or_unresolved AS "lateOrUnresolved", checksum, (SELECT COALESCE(jsonb_agg(jsonb_build_object(\'ticketId\', r.ticket_id, \'outcome\', r.outcome, \'terminalAt\', r.terminal_at, \'exclusion\', r.exclusion) ORDER BY r.ticket_id), \'[]\'::jsonb) FROM support_sla_reporting_results r WHERE r.workspace_id = run.workspace_id AND r.report_id = run.report_id) AS "ticketResults" FROM support_sla_reporting_runs run WHERE workspace_id=$1 AND report_id=$2', [report.workspaceId, report.reportId])
      if (existing.rows[0]) {
        const found = reportFromRow(existing.rows[0])
        if (found.checksum !== report.checksum) throw new Error('SUPPORT_SLA_REPORT_IMMUTABLE_CONFLICT')
        return found
      }
      await client.query('INSERT INTO support_sla_reporting_runs (workspace_id, report_id, period_start, period_end, cutoff_at, policy_versions_json, calendar_versions_json, denominator, met, failed, excluded, late_or_unresolved, checksum) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [report.workspaceId, report.reportId, report.periodStart, report.periodEnd, report.cutoffAt, JSON.stringify(report.policyVersions), JSON.stringify(report.calendarVersions), report.denominator, report.met, report.failed, report.excluded, report.lateOrUnresolved, report.checksum])
      for (const item of report.ticketResults) {
        await client.query('INSERT INTO support_sla_reporting_results (workspace_id, report_id, ticket_id, outcome, terminal_at, exclusion) VALUES ($1,$2,$3,$4,$5,$6)', [report.workspaceId, report.reportId, item.ticketId, item.outcome, item.terminalAt ?? null, item.exclusion ?? null])
        if (item.outcome === 'excluded') await client.query('INSERT INTO support_sla_reporting_exclusions (workspace_id, report_id, ticket_id, exclusion) VALUES ($1,$2,$3,$4)', [report.workspaceId, report.reportId, item.ticketId, item.exclusion])
      }
      return structuredClone(report)
    })
  }

  async getReport(input: { workspaceId: string; reportId: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<Record<string, unknown>>('SELECT run.report_id AS "reportId", run.workspace_id AS "workspaceId", run.period_start AS "periodStart", run.period_end AS "periodEnd", run.cutoff_at AS "cutoffAt", run.policy_versions_json AS "policyVersions", run.calendar_versions_json AS "calendarVersions", run.denominator, run.met, run.failed, run.excluded, run.late_or_unresolved AS "lateOrUnresolved", run.checksum, COALESCE(jsonb_agg(jsonb_build_object(\'ticketId\', result.ticket_id, \'outcome\', result.outcome, \'terminalAt\', result.terminal_at, \'exclusion\', result.exclusion) ORDER BY result.ticket_id) FILTER (WHERE result.ticket_id IS NOT NULL), \'[]\'::jsonb) AS "ticketResults" FROM support_sla_reporting_runs run LEFT JOIN support_sla_reporting_results result ON result.workspace_id=run.workspace_id AND result.report_id=run.report_id WHERE run.workspace_id=$1 AND run.report_id=$2 GROUP BY run.report_id, run.workspace_id', [input.workspaceId, input.reportId])
      return result.rows[0] ? reportFromRow(result.rows[0]) : undefined
    })
  }

  async listReports(input: { workspaceId: string; limit?: number }) {
    requireWorkspaceScope(input.workspaceId)
    const limit = Math.min(100, Math.max(1, input.limit ?? 50))
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<Record<string, unknown>>('SELECT run.report_id AS "reportId", run.workspace_id AS "workspaceId", run.period_start AS "periodStart", run.period_end AS "periodEnd", run.cutoff_at AS "cutoffAt", run.policy_versions_json AS "policyVersions", run.calendar_versions_json AS "calendarVersions", run.denominator, run.met, run.failed, run.excluded, run.late_or_unresolved AS "lateOrUnresolved", run.checksum, \'[]\'::jsonb AS "ticketResults" FROM support_sla_reporting_runs run WHERE run.workspace_id=$1 ORDER BY run.period_start DESC, run.report_id DESC LIMIT $2', [input.workspaceId, limit])
      return result.rows.map(reportFromRow)
    })
  }

  async createCorrection(input: { correction: SupportSlaCorrectionRun }) {
    const correction = input.correction
    requireWorkspaceScope(correction.workspaceId)
    return withWorkspaceTransaction(this.pool, correction.workspaceId, async client => {
      const existing = await client.query<SupportSlaCorrectionRun>('SELECT correction_id AS "correctionId", original_report_id AS "originalReportId", workspace_id AS "workspaceId", reason, source_checksum AS "sourceChecksum", corrected_checksum AS "correctedChecksum", idempotency_key AS "idempotencyKey", status FROM support_sla_correction_runs WHERE workspace_id=$1 AND correction_id=$2', [correction.workspaceId, correction.correctionId])
      if (existing.rows[0]) {
        if (existing.rows[0].correctedChecksum !== correction.correctedChecksum) throw new Error('SUPPORT_SLA_CORRECTION_IMMUTABLE_CONFLICT')
        return existing.rows[0]
      }
      await client.query('INSERT INTO support_sla_correction_runs (workspace_id, correction_id, original_report_id, reason, source_checksum, corrected_checksum, idempotency_key, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [correction.workspaceId, correction.correctionId, correction.originalReportId, correction.reason, correction.sourceChecksum, correction.correctedChecksum, correction.idempotencyKey, correction.status])
      return structuredClone(correction)
    })
  }

  async getCorrection(input: { workspaceId: string; correctionId: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<SupportSlaCorrectionRun>('SELECT correction_id AS "correctionId", original_report_id AS "originalReportId", workspace_id AS "workspaceId", reason, source_checksum AS "sourceChecksum", corrected_checksum AS "correctedChecksum", idempotency_key AS "idempotencyKey", status FROM support_sla_correction_runs WHERE workspace_id=$1 AND correction_id=$2', [input.workspaceId, input.correctionId])
      return result.rows[0]
    })
  }

  async decideCorrection(input: { decision: SupportSlaCorrectionDecision }) {
    const decision = input.decision
    requireWorkspaceScope(decision.workspaceId)
    return withWorkspaceTransaction(this.pool, decision.workspaceId, async client => {
      const existing = await client.query<SupportSlaCorrectionDecision>('SELECT decision_id AS "decisionId", correction_id AS "correctionId", workspace_id AS "workspaceId", decision, reason, actor_id AS "actorId", idempotency_key AS "idempotencyKey", decided_at AS "decidedAt" FROM support_sla_correction_decisions WHERE workspace_id=$1 AND correction_id=$2', [decision.workspaceId, decision.correctionId])
      if (existing.rows[0]) {
        if (existing.rows[0].idempotencyKey !== decision.idempotencyKey) throw new Error('SUPPORT_SLA_CORRECTION_DECISION_IMMUTABLE_CONFLICT')
        return existing.rows[0]
      }
      await client.query('INSERT INTO support_sla_correction_decisions (workspace_id, decision_id, correction_id, decision, reason, actor_id, idempotency_key, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [decision.workspaceId, decision.decisionId, decision.correctionId, decision.decision, decision.reason, decision.actorId, decision.idempotencyKey, decision.decidedAt])
      return structuredClone(decision)
    })
  }

  async getCorrectionDecision(input: { workspaceId: string; correctionId: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<SupportSlaCorrectionDecision>('SELECT decision_id AS "decisionId", correction_id AS "correctionId", workspace_id AS "workspaceId", decision, reason, actor_id AS "actorId", idempotency_key AS "idempotencyKey", decided_at AS "decidedAt" FROM support_sla_correction_decisions WHERE workspace_id=$1 AND correction_id=$2', [input.workspaceId, input.correctionId])
      return result.rows[0]
    })
  }

  async addCorrectionApproval(input: { approval: SupportSlaCorrectionApproval }) {
    const approval = input.approval
    requireWorkspaceScope(approval.workspaceId)
    return withWorkspaceTransaction(this.pool, approval.workspaceId, async client => {
      const existing = await client.query<SupportSlaCorrectionApproval>('SELECT approval_id AS "approvalId", correction_id AS "correctionId", workspace_id AS "workspaceId", decision, reason, actor_id AS "actorId", idempotency_key AS "idempotencyKey", approved_at AS "approvedAt" FROM support_sla_correction_approvals WHERE workspace_id=$1 AND approval_id=$2', [approval.workspaceId, approval.approvalId])
      if (existing.rows[0]) {
        if (existing.rows[0].idempotencyKey !== approval.idempotencyKey) throw new Error('SUPPORT_SLA_CORRECTION_APPROVAL_IMMUTABLE_CONFLICT')
        return existing.rows[0]
      }
      await client.query('INSERT INTO support_sla_correction_approvals (workspace_id, approval_id, correction_id, decision, reason, actor_id, idempotency_key, approved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [approval.workspaceId, approval.approvalId, approval.correctionId, approval.decision, approval.reason, approval.actorId, approval.idempotencyKey, approval.approvedAt])
      return structuredClone(approval)
    })
  }

  async listCorrectionApprovals(input: { workspaceId: string; correctionId: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<SupportSlaCorrectionApproval>('SELECT approval_id AS "approvalId", correction_id AS "correctionId", workspace_id AS "workspaceId", decision, reason, actor_id AS "actorId", idempotency_key AS "idempotencyKey", approved_at AS "approvedAt" FROM support_sla_correction_approvals WHERE workspace_id=$1 AND correction_id=$2 ORDER BY approved_at, approval_id', [input.workspaceId, input.correctionId])
      return result.rows
    })
  }
}
