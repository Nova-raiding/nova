import { requireWorkspaceScope, withWorkspaceTransaction, type SqlClient, type SqlPool } from './repository.js'

export interface PersistedRuleVersion {
  id: string
  workspaceId: string
  packId: string
  name: string
  version: string
  scope: string
  status: string
  sourceKind: string
  sourceReference: string
  sourceCheckedAt: string
  checksum: string
  checks: Record<string, unknown>
  createdAt: string | Date
  updatedAt: string | Date
  createdBy: string
  revision: number
  effectiveFrom?: string | Date | null
  effectiveTo?: string | Date | null
  severity?: string | null
  action?: string | null
  targetId?: string | null
  scopeValue?: string | null
  activatedAt?: string | Date | null
  deactivatedAt?: string | Date | null
}

export interface PersistedRuleAudit {
  id: string
  workspaceId: string
  rulePackId: string
  ruleVersionId: string
  version: string
  action: string
  actorId: string
  reason?: string | null
  occurredAt: string | Date
  data: Record<string, unknown>
}

type RuleVersionRow = {
  id: string; workspace_id: string; pack_id: string; name: string; version: string; scope: string; status: string
  source_kind: string; source_reference: string; source_checked_at: string | Date; checksum: string
  checks: Record<string, unknown>; created_at: string | Date; updated_at: string | Date; created_by: string
  revision: number; effective_from?: string | Date | null; effective_to?: string | Date | null; severity?: string | null; action?: string | null; target_id?: string | null; scope_value?: string | null; activated_at?: string | Date | null; deactivated_at?: string | Date | null
}

type RuleAuditRow = {
  id: string; workspace_id: string; rule_pack_id: string; rule_version_id: string; version: string; action: string
  actor_id: string; reason?: string | null; occurred_at: string | Date; data: Record<string, unknown>
}

const asIso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const version = (row: RuleVersionRow): PersistedRuleVersion => ({
  id: row.id, workspaceId: row.workspace_id, packId: row.pack_id, name: row.name, version: row.version,
  scope: row.scope, status: row.status, sourceKind: row.source_kind, sourceReference: row.source_reference,
  sourceCheckedAt: asIso(row.source_checked_at), checksum: row.checksum, checks: row.checks,
  createdAt: asIso(row.created_at), updatedAt: asIso(row.updated_at), createdBy: row.created_by, revision: row.revision,
  ...(row.effective_from ? { effectiveFrom: asIso(row.effective_from) } : {}), ...(row.effective_to ? { effectiveTo: asIso(row.effective_to) } : {}),
  ...(row.severity ? { severity: row.severity } : {}), ...(row.action ? { action: row.action } : {}), ...(row.target_id ? { targetId: row.target_id } : {}), ...(row.scope_value ? { scopeValue: row.scope_value } : {}),
  ...(row.activated_at ? { activatedAt: asIso(row.activated_at) } : {}),
  ...(row.deactivated_at ? { deactivatedAt: asIso(row.deactivated_at) } : {}),
})
const audit = (row: RuleAuditRow): PersistedRuleAudit => ({
  id: row.id, workspaceId: row.workspace_id, rulePackId: row.rule_pack_id, ruleVersionId: row.rule_version_id,
  version: row.version, action: row.action, actorId: row.actor_id, ...(row.reason ? { reason: row.reason } : {}),
  occurredAt: asIso(row.occurred_at), data: row.data,
})

/** Tenant-scoped persistence boundary for the rule center. The application
 * registry remains useful for fixture mode; production callers can persist
 * immutable versions and append-only audits through this repository. */
export class PostgresRuleRepository {
  constructor(private readonly pool: SqlPool) {}

  async list(workspaceId: string, packId?: string): Promise<PersistedRuleVersion[]> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<RuleVersionRow>(
        `SELECT id, workspace_id, pack_id, name, version, scope, status, source_kind, source_reference,
                source_checked_at, checksum, checks, created_at, updated_at, created_by, revision, effective_from, effective_to, severity, action, target_id, scope_value,
                activated_at, deactivated_at
           FROM rule_pack_versions
          WHERE workspace_id = $1 AND ($2::text IS NULL OR pack_id = $2)
          ORDER BY pack_id, created_at, version`, [scope, packId ?? null],
      )
      return result.rows.map(version)
    })
  }

  async insertVersion(input: Omit<PersistedRuleVersion, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<PersistedRuleVersion> {
    const scope = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => this.insertVersionInTransaction(client, { ...input, workspaceId: scope }))
  }

  async insertVersionInTransaction(client: SqlClient, input: Omit<PersistedRuleVersion, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<PersistedRuleVersion> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const createdAt = input.createdAt ?? new Date().toISOString()
    const updatedAt = input.updatedAt ?? createdAt
    const result = await client.query<RuleVersionRow>(
      `INSERT INTO rule_pack_versions
       (id, workspace_id, pack_id, name, version, scope, status, source_kind, source_reference, source_checked_at,
        checksum, checks, created_at, updated_at, created_by, revision, effective_from, effective_to, severity, action, target_id, scope_value, activated_at, deactivated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING id, workspace_id, pack_id, name, version, scope, status, source_kind, source_reference,
                 source_checked_at, checksum, checks, created_at, updated_at, created_by, revision, effective_from, effective_to, severity, action, target_id, scope_value,
                 activated_at, deactivated_at`,
      [input.id, workspaceId, input.packId, input.name, input.version, input.scope, input.status, input.sourceKind,
        input.sourceReference, input.sourceCheckedAt, input.checksum, JSON.stringify(input.checks), createdAt, updatedAt,
        input.createdBy, input.revision, input.effectiveFrom ?? null, input.effectiveTo ?? null, input.severity ?? null, input.action ?? null, input.targetId ?? null, input.scopeValue ?? null, input.activatedAt ?? null, input.deactivatedAt ?? null],
    )
    if (!result.rows[0]) throw new Error('RULE_VERSION_NOT_PERSISTED')
    return version(result.rows[0])
  }

  async insertVersionWithAudit(input: {
    version: Omit<PersistedRuleVersion, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }
    audit: PersistedRuleAudit
  }): Promise<{ version: PersistedRuleVersion; audit: PersistedRuleAudit }> {
    const workspaceId = requireWorkspaceScope(input.version.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const created = await this.insertVersionInTransaction(client, { ...input.version, workspaceId })
      const audit = await this.appendAuditInTransaction(client, { ...input.audit, workspaceId, ruleVersionId: created.id, version: created.version })
      return { version: created, audit }
    })
  }

  async appendAudit(input: PersistedRuleAudit): Promise<PersistedRuleAudit> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<RuleAuditRow>(
        `INSERT INTO rule_audit_events (id, workspace_id, rule_pack_id, rule_version_id, version, action, actor_id, reason, occurred_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         RETURNING id, workspace_id, rule_pack_id, rule_version_id, version, action, actor_id, reason, occurred_at, data`,
        [input.id, workspaceId, input.rulePackId, input.ruleVersionId, input.version, input.action, input.actorId,
          input.reason ?? null, input.occurredAt, JSON.stringify(input.data)],
      )
      if (!result.rows[0]) throw new Error('RULE_AUDIT_NOT_PERSISTED')
      return audit(result.rows[0])
    })
  }

  async updateStatus(input: { workspaceId: string; id: string; status: string; revision: number; updatedAt?: string; activatedAt?: string | null; deactivatedAt?: string | null }): Promise<PersistedRuleVersion> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<RuleVersionRow>(
        `UPDATE rule_pack_versions
            SET status = $3, revision = $4, updated_at = $5, activated_at = $6, deactivated_at = $7
          WHERE workspace_id = $1 AND id = $2
          RETURNING id, workspace_id, pack_id, name, version, scope, status, source_kind, source_reference,
                    source_checked_at, checksum, checks, created_at, updated_at, created_by, revision, effective_from, effective_to, severity, action, target_id, scope_value,
                    activated_at, deactivated_at`,
        [workspaceId, input.id, input.status, input.revision, input.updatedAt ?? new Date().toISOString(), input.activatedAt ?? null, input.deactivatedAt ?? null],
      )
      if (!result.rows[0]) throw new Error('RULE_VERSION_NOT_FOUND')
      return version(result.rows[0])
    })
  }

  /** Atomically replaces the active version and appends both lifecycle audit
   * records in one workspace-scoped transaction. */
  async transitionStatusWithAudit(input: {
    workspaceId: string; packId: string; targetId: string; status: string; actorId: string; reason: string; occurredAt: string
    targetAuditId: string; currentAuditId?: string; auditData?: Record<string, unknown>
  }): Promise<{ version: PersistedRuleVersion; audits: PersistedRuleAudit[] }> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const targetResult = await client.query<RuleVersionRow>(
        `SELECT id, workspace_id, pack_id, name, version, scope, status, source_kind, source_reference,
                source_checked_at, checksum, checks, created_at, updated_at, created_by, revision, effective_from, effective_to, severity, action, target_id, scope_value,
                activated_at, deactivated_at
           FROM rule_pack_versions WHERE workspace_id = $1 AND pack_id = $2 AND id = $3 FOR UPDATE`,
        [workspaceId, input.packId, input.targetId],
      )
      const target = targetResult.rows[0]
      if (!target) throw new Error('RULE_VERSION_NOT_FOUND')
      const audits: PersistedRuleAudit[] = []
      if (input.status === 'active') {
        const currentResult = await client.query<RuleVersionRow>(
          `SELECT id, workspace_id, pack_id, name, version, scope, status, source_kind, source_reference,
                  source_checked_at, checksum, checks, created_at, updated_at, created_by, revision, effective_from, effective_to, severity, action, target_id, scope_value,
                  activated_at, deactivated_at
             FROM rule_pack_versions
            WHERE workspace_id = $1 AND pack_id = $2 AND status = 'active' AND id <> $3 FOR UPDATE`,
          [workspaceId, input.packId, input.targetId],
        )
        for (const current of currentResult.rows) {
          const oldResult = await client.query<RuleVersionRow>(
            `UPDATE rule_pack_versions SET status = 'inactive', revision = revision + 1, updated_at = $4, deactivated_at = $4
              WHERE workspace_id = $1 AND pack_id = $2 AND id = $3
              RETURNING id, workspace_id, pack_id, name, version, scope, status, source_kind, source_reference,
                        source_checked_at, checksum, checks, created_at, updated_at, created_by, revision, effective_from, effective_to, severity, action, target_id, scope_value,
                        activated_at, deactivated_at`,
            [workspaceId, input.packId, current.id, input.occurredAt],
          )
          const old = oldResult.rows[0]!
          if (input.currentAuditId) audits.push(await this.appendAuditInTransaction(client, { id: input.currentAuditId, workspaceId, rulePackId: input.packId, ruleVersionId: old.id, version: old.version, action: 'deactivated', actorId: input.actorId, reason: input.reason, occurredAt: input.occurredAt, data: { replacement: input.targetId } }))
        }
      }
      const updatedResult = await client.query<RuleVersionRow>(
        `UPDATE rule_pack_versions
            SET status = $4::text, revision = revision + 1, updated_at = $5::timestamptz,
                activated_at = CASE WHEN $4::text = 'active' THEN $5::timestamptz ELSE NULL END,
                deactivated_at = CASE WHEN $4::text = 'active' THEN NULL ELSE $5::timestamptz END
          WHERE workspace_id = $1 AND pack_id = $2 AND id = $3
          RETURNING id, workspace_id, pack_id, name, version, scope, status, source_kind, source_reference,
                    source_checked_at, checksum, checks, created_at, updated_at, created_by, revision, effective_from, effective_to, severity, action, target_id, scope_value,
                    activated_at, deactivated_at`,
        [workspaceId, input.packId, input.targetId, input.status, input.occurredAt],
      )
      const updated = updatedResult.rows[0]!
      audits.push(await this.appendAuditInTransaction(client, { id: input.targetAuditId, workspaceId, rulePackId: input.packId, ruleVersionId: updated.id, version: updated.version, action: input.status === 'active' ? 'activated' : input.status === 'expired' ? 'expired' : 'deactivated', actorId: input.actorId, reason: input.reason, occurredAt: input.occurredAt, data: input.auditData ?? {} }))
      return { version: version(updated), audits }
    })
  }

  private async appendAuditInTransaction(client: SqlClient, input: PersistedRuleAudit): Promise<PersistedRuleAudit> {
    const result = await client.query<RuleAuditRow>(
      `INSERT INTO rule_audit_events (id, workspace_id, rule_pack_id, rule_version_id, version, action, actor_id, reason, occurred_at, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       RETURNING id, workspace_id, rule_pack_id, rule_version_id, version, action, actor_id, reason, occurred_at, data`,
      [input.id, input.workspaceId, input.rulePackId, input.ruleVersionId, input.version, input.action, input.actorId, input.reason ?? null, input.occurredAt, JSON.stringify(input.data)],
    )
    if (!result.rows[0]) throw new Error('RULE_AUDIT_NOT_PERSISTED')
    return audit(result.rows[0])
  }

  async listAudit(workspaceId: string, packId?: string): Promise<PersistedRuleAudit[]> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<RuleAuditRow>(
        `SELECT id, workspace_id, rule_pack_id, rule_version_id, version, action, actor_id, reason, occurred_at, data
           FROM rule_audit_events
          WHERE workspace_id = $1 AND ($2::text IS NULL OR rule_pack_id = $2)
          ORDER BY occurred_at, id`, [scope, packId ?? null],
      )
      return result.rows.map(audit)
    })
  }
}
