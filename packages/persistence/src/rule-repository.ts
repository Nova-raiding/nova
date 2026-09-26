import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, withWorkspaceTransaction, type SqlClient, type SqlPool } from './repository.js'

export interface PersistedRuleVersion {
  id: string
  workspaceId: string
  packId: string
  name: string
  version: string
  scope: string
  category?: string | null
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

export interface PublicRuleReviewCursor {
  createdAt: string
  id: string
}

export interface PublicRuleReviewPage {
  items: PersistedRuleVersion[]
  nextCursor?: PublicRuleReviewCursor
}

type RuleVersionRow = {
  id: string; workspace_id: string; pack_id: string; name: string; version: string; scope: string; category?: string | null; status: string
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
  scope: row.scope, ...(row.category ? { category: row.category } : {}), status: row.status, sourceKind: row.source_kind, sourceReference: row.source_reference,
  sourceCheckedAt: asIso(row.source_checked_at), checksum: row.checksum, checks: row.checks,
  createdAt: asIso(row.created_at), updatedAt: asIso(row.updated_at), createdBy: row.created_by, revision: Number(row.revision),
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
  /**
   * Shared platform rules are a control-plane surface, so the split between the
   * two pools is load-bearing rather than cosmetic:
   *
   * - Reads stay on the tenant pool. Migration 219 deliberately grants
   *   `merchant_app` SELECT on the shared rule tables, and every merchant reads
   *   platform policy through its own connection.
   * - Writes must go through the operations role. 219 grants INSERT/UPDATE only
   *   to `merchant_ops`; writing through the tenant pool happens to work on the
   *   ECS Compose path (whose bootstrap re-runs a blanket `GRANT ... ON ALL
   *   TABLES` after the migrations, silently widening `merchant_app` back to
   *   full DML on every shared table) and fails with 42501 on the Kubernetes
   *   path (no such bootstrap). Both outcomes are wrong: one escalates the
   *   tenant role across tenants, the other breaks platform-rule publishing.
   */
  constructor(private readonly pool: SqlPool, private readonly platformPool?: SqlPool) {}

  private get publicWritePool(): SqlPool {
    return this.platformPool ?? this.pool
  }

  async list(workspaceId: string, packId?: string): Promise<PersistedRuleVersion[]> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<RuleVersionRow>(
        `SELECT id, workspace_id, pack_id, name, version, scope, category, status, source_kind, source_reference,
                source_checked_at, checksum, checks, created_at, updated_at, created_by, revision, effective_from, effective_to, severity, action, target_id, scope_value,
                activated_at, deactivated_at
           FROM rule_pack_versions
          WHERE workspace_id = $1 AND ($2::text IS NULL OR pack_id = $2)
          ORDER BY pack_id, created_at, version`, [scope, packId ?? null],
      )
      return result.rows.map(version)
    })
  }

  /** Public platform policy is shared across merchant workspaces. The
   * workspace id is only attached to the projection so existing evaluation
   * code can apply its tenant-scoped response shape; the source rows remain
   * deliberately workspace-free and read-only to merchant_app. */
  async listPublic(workspaceId: string, platform?: string): Promise<PersistedRuleVersion[]> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<RuleVersionRow>(
        `SELECT id, $1::text AS workspace_id, pack_id, name, version, 'platform' AS scope,
                NULL::text AS category, status, source_kind, source_reference, source_checked_at,
                checksum, checks, created_at, updated_at, created_by, revision,
                effective_from, effective_to, severity, action, NULL::text AS target_id,
                platform AS scope_value, activated_at, deactivated_at
           FROM public_platform_rule_versions
          WHERE status = 'active' AND ($2::text IS NULL OR platform = $2)
          ORDER BY platform, pack_id, version`, [scope, platform ?? null],
      )
      return result.rows.map(version)
    })
  }

  /** Platform-only governance read. Keep separate from listPublic(), whose
   * tenant-facing contract intentionally exposes active policy only. */
  async listPublicDraftsForReview(input: { platform?: string; limit: number; cursor?: PublicRuleReviewCursor }): Promise<PublicRuleReviewPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('PUBLIC_RULE_REVIEW_LIMIT_INVALID')
    return withWorkspaceTransaction(this.publicWritePool, '__platform_rules__', async client => {
      const result = await client.query<RuleVersionRow>(
        `SELECT id, '__platform_rules__'::text AS workspace_id, pack_id, name, version, 'platform' AS scope,
                NULL::text AS category, status, source_kind, source_reference, source_checked_at,
                checksum, checks, created_at, updated_at, created_by, revision, effective_from,
                effective_to, severity, action, NULL::text AS target_id, platform AS scope_value,
                activated_at, deactivated_at
           FROM public_platform_rule_versions
          WHERE status = 'draft'
            AND ($1::text IS NULL OR platform = $1)
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::text))
          ORDER BY created_at DESC, id DESC
          LIMIT $4`, [input.platform ?? null, input.cursor?.createdAt ?? null, input.cursor?.id ?? null, input.limit + 1],
      )
      const hasMore = result.rows.length > input.limit
      const pageRows = hasMore ? result.rows.slice(0, input.limit) : result.rows
      const items = pageRows.map(version)
      const last = items.at(-1)
      return {
        items,
        ...(hasMore && last ? { nextCursor: { createdAt: asIso(last.createdAt), id: last.id } } : {}),
      }
    })
  }

  /** Exact platform/pack/version preview. It intentionally includes lifecycle
   * state so reviewers can re-open the same immutable version after approval. */
  async getPublicRuleForReview(platform: string, packId: string, requestedVersion: string): Promise<PersistedRuleVersion | undefined> {
    return withWorkspaceTransaction(this.publicWritePool, '__platform_rules__', async client => {
      const result = await client.query<RuleVersionRow>(
        `SELECT id, '__platform_rules__'::text AS workspace_id, pack_id, name, version, 'platform' AS scope,
                NULL::text AS category, status, source_kind, source_reference, source_checked_at,
                checksum, checks, created_at, updated_at, created_by, revision, effective_from,
                effective_to, severity, action, NULL::text AS target_id, platform AS scope_value,
                activated_at, deactivated_at
           FROM public_platform_rule_versions
          WHERE platform = $1 AND pack_id = $2 AND version = $3`, [platform, packId, requestedVersion],
      )
      return result.rows[0] ? version(result.rows[0]) : undefined
    })
  }

  async listPublicRuleAuditForReview(platform: string, packId: string, requestedVersion: string): Promise<PersistedRuleAudit[]> {
    return withWorkspaceTransaction(this.publicWritePool, '__platform_rules__', async client => {
      const result = await client.query<RuleAuditRow>(
        `SELECT a.id, '__platform_rules__'::text AS workspace_id, v.pack_id AS rule_pack_id,
                a.rule_version_id, a.version, a.action, a.actor_id, a.reason, a.occurred_at, a.data
           FROM public_platform_rule_audits a
           JOIN public_platform_rule_versions v ON v.id = a.rule_version_id
          WHERE v.platform = $1 AND v.pack_id = $2 AND v.version = $3
            AND a.platform = v.platform AND a.version = v.version
          ORDER BY a.occurred_at ASC, a.id ASC`, [platform, packId, requestedVersion],
      )
      return result.rows.map(audit)
    })
  }

  async insertPublicVersionWithAudit(input: {
    version: Omit<PersistedRuleVersion, 'workspaceId' | 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }
    audit: Omit<PersistedRuleAudit, 'workspaceId'>
  }): Promise<{ version: PersistedRuleVersion; audit: PersistedRuleAudit }> {
    const createdAt = input.version.createdAt ?? new Date().toISOString()
    const updatedAt = input.version.updatedAt ?? createdAt
    const auditInput = input.audit
    return withWorkspaceTransaction(this.publicWritePool, '__platform_rules__', async client => {
      const result = await client.query<RuleVersionRow>(
        `INSERT INTO public_platform_rule_versions
         (id, platform, pack_id, name, version, status, source_kind, source_reference, source_checked_at,
          checksum, checks, severity, action, effective_from, effective_to, created_by, created_at, updated_at,
          activated_at, deactivated_at, revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING id, $22::text AS workspace_id, pack_id, name, version, 'platform' AS scope,
                   NULL::text AS category, status, source_kind, source_reference, source_checked_at,
                   checksum, checks, created_at, updated_at, created_by, revision, effective_from,
                   effective_to, severity, action, NULL::text AS target_id, platform AS scope_value,
                   activated_at, deactivated_at`,
        [input.version.id, input.version.targetId ?? input.version.scopeValue, input.version.packId, input.version.name, input.version.version, input.version.status,
          input.version.sourceKind, input.version.sourceReference, input.version.sourceCheckedAt, input.version.checksum, JSON.stringify(input.version.checks),
          input.version.severity ?? 'error', input.version.action ?? 'block', input.version.effectiveFrom ?? null, input.version.effectiveTo ?? null,
          input.version.createdBy, createdAt, updatedAt, input.version.activatedAt ?? null, input.version.deactivatedAt ?? null, input.version.revision, '__platform_rules__'],
      )
      const row = result.rows[0]
      if (!row) throw new Error('PUBLIC_RULE_VERSION_NOT_PERSISTED')
      const auditResult = await client.query<RuleAuditRow>(
        `INSERT INTO public_platform_rule_audits (id, rule_version_id, platform, version, action, actor_id, reason, occurred_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         RETURNING id, '__platform_rules__'::text AS workspace_id, rule_version_id, platform AS rule_pack_id, version, action, actor_id, reason, occurred_at, data`,
        [auditInput.id, row.id, input.version.targetId ?? input.version.scopeValue, row.version, auditInput.action, auditInput.actorId, auditInput.reason ?? '', auditInput.occurredAt, JSON.stringify(auditInput.data)],
      )
      if (!auditResult.rows[0]) throw new Error('PUBLIC_RULE_AUDIT_NOT_PERSISTED')
      return { version: version(row), audit: audit(auditResult.rows[0]) }
    })
  }

  async getPublicVersion(platform: string, packId: string, requestedVersion: string): Promise<PersistedRuleVersion | undefined> {
    return withWorkspaceTransaction(this.publicWritePool, '__platform_rules__', async client => {
      const result = await client.query<RuleVersionRow>(
        `SELECT id, '__platform_rules__'::text AS workspace_id, pack_id, name, version, 'platform' AS scope,
                NULL::text AS category, status, source_kind, source_reference, source_checked_at,
                checksum, checks, created_at, updated_at, created_by, revision,
                effective_from, effective_to, severity, action, NULL::text AS target_id,
                platform AS scope_value, activated_at, deactivated_at
           FROM public_platform_rule_versions
          WHERE platform = $1 AND pack_id = $2 AND version = $3`, [platform, packId, requestedVersion],
      )
      return result.rows[0] ? version(result.rows[0]) : undefined
    })
  }

  async transitionPublicStatus(input: { platform: string; packId: string; version: string; expectedRevision: number; status: string; actorId: string; reason: string; occurredAt: string; auditData?: Record<string, unknown> }): Promise<PersistedRuleVersion> {
    return withWorkspaceTransaction(this.publicWritePool, '__platform_rules__', async client => {
      const updated = await client.query<RuleVersionRow>(
        `UPDATE public_platform_rule_versions
            SET status = $4, revision = revision + 1, updated_at = $5,
                activated_at = CASE WHEN $4 = 'active' THEN $5 ELSE activated_at END,
                deactivated_at = CASE WHEN $4 <> 'active' THEN $5 ELSE NULL END
          WHERE platform = $1 AND pack_id = $2 AND version = $3 AND revision = $6
          RETURNING id, '__platform_rules__'::text AS workspace_id, pack_id, name, version, 'platform' AS scope,
                    NULL::text AS category, status, source_kind, source_reference, source_checked_at,
                    checksum, checks, created_at, updated_at, created_by, revision, effective_from,
                    effective_to, severity, action, NULL::text AS target_id, platform AS scope_value,
                    activated_at, deactivated_at`,
        [input.platform, input.packId, input.version, input.status, input.occurredAt, input.expectedRevision],
      )
      const row = updated.rows[0]
      if (!row) {
        const current = await client.query<{ revision: number }>(
          `SELECT revision FROM public_platform_rule_versions WHERE platform = $1 AND pack_id = $2 AND version = $3`,
          [input.platform, input.packId, input.version],
        )
        const conflict = current.rows[0]
          ? Object.assign(new Error('PUBLIC_RULE_REVISION_CONFLICT'), { code: 'PUBLIC_RULE_REVISION_CONFLICT' })
          : Object.assign(new Error('PUBLIC_RULE_VERSION_NOT_FOUND'), { code: 'PUBLIC_RULE_VERSION_NOT_FOUND' })
        throw conflict
      }
      await client.query(
        `INSERT INTO public_platform_rule_audits (id, rule_version_id, platform, version, action, actor_id, reason, occurred_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [`public_rule_audit_${randomUUID()}`, row.id, input.platform, row.version, input.status === 'active' ? 'activated' : input.status === 'expired' ? 'expired' : 'deactivated', input.actorId, input.reason, input.occurredAt, JSON.stringify(input.auditData ?? {})],
      )
      return version(row)
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
       (id, workspace_id, pack_id, name, version, scope, category, status, source_kind, source_reference, source_checked_at,
        checksum, checks, created_at, updated_at, created_by, revision, effective_from, effective_to, severity, action, target_id, scope_value, activated_at, deactivated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       RETURNING id, workspace_id, pack_id, name, version, scope, category, status, source_kind, source_reference,
                 source_checked_at, checksum, checks, created_at, updated_at, created_by, revision, effective_from, effective_to, severity, action, target_id, scope_value,
                 activated_at, deactivated_at`,
      [input.id, workspaceId, input.packId, input.name, input.version, input.scope, input.category ?? null, input.status, input.sourceKind,
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
