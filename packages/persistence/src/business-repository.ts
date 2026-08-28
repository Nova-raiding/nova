import { withWorkspaceTransaction, requireWorkspaceScope, type SqlClient, type SqlPool } from './repository.js'

export type BusinessEntityType = 'product' | 'task' | 'content_version' | 'publish_job' | 'publish_batch' | 'platform_account' | 'generation_job' | 'image_generation_job' | 'brand_profile' | 'asset' | 'feedback' | 'sync_job' | 'automation_policy'

export interface SaveBusinessSnapshotInput {
  workspaceId: string
  entityType: BusinessEntityType
  entityId: string
  entityVersion: number
  payload: Record<string, unknown>
}

export interface BusinessSnapshot extends SaveBusinessSnapshotInput {
  createdAt: string
  updatedAt: string
}

export class BusinessSnapshotNotFoundError extends Error {
  constructor() { super('business snapshot not found') }
}

export class BusinessSnapshotVersionConflictError extends Error {
  readonly code = 'BUSINESS_SNAPSHOT_VERSION_CONFLICT'
  constructor(readonly workspaceId: string, readonly entityType: BusinessEntityType, readonly entityId: string, readonly entityVersion: number) {
    super('business snapshot changed at the same entity version')
  }
}

type BusinessSnapshotRow = {
  workspace_id: string
  entity_type: BusinessEntityType
  entity_id: string
  entity_version: number
  payload: Record<string, unknown>
  created_at: string | Date
  updated_at: string | Date
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function toSnapshot(row: BusinessSnapshotRow): BusinessSnapshot {
  return {
    workspaceId: row.workspace_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityVersion: row.entity_version,
    payload: row.payload,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Tenant-scoped durable snapshot repository used during aggregate persistence migration. */
export class PostgresBusinessRepository {
  constructor(private readonly pool: SqlPool, private readonly options: { normalizedProjection?: boolean } = {}) {}

  async save(input: SaveBusinessSnapshotInput): Promise<BusinessSnapshot> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, client => this.saveInTransaction(client, input))
  }

  /** Save inside a caller-owned transaction so business state and outbox can commit atomically. */
  async saveInTransaction(client: SqlClient, input: SaveBusinessSnapshotInput): Promise<BusinessSnapshot> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    if (!input.entityId || !input.entityType) throw new Error('business snapshot identity is required')
    if (!Number.isInteger(input.entityVersion) || input.entityVersion < 1) throw new RangeError('entityVersion must be positive')
    const result = await client.query<BusinessSnapshotRow>(
      `INSERT INTO business_entity_snapshots
        (workspace_id, entity_type, entity_id, entity_version, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (workspace_id, entity_type, entity_id)
       DO UPDATE SET entity_version = EXCLUDED.entity_version,
                     payload = EXCLUDED.payload,
                     updated_at = now()
        WHERE business_entity_snapshots.entity_version < EXCLUDED.entity_version
       RETURNING workspace_id, entity_type, entity_id, entity_version, payload, created_at, updated_at`,
      [workspaceId, input.entityType, input.entityId, input.entityVersion, JSON.stringify(input.payload)],
    )
    if (result.rows[0]) {
      const snapshot = toSnapshot(result.rows[0])
      if (this.options.normalizedProjection) await this.projectNormalizedInTransaction(client, input)
      return snapshot
    }
    const existing = await client.query<BusinessSnapshotRow>(
      `SELECT workspace_id, entity_type, entity_id, entity_version, payload, created_at, updated_at
         FROM business_entity_snapshots
        WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3
        LIMIT 1`,
      [workspaceId, input.entityType, input.entityId],
    )
    if (!existing.rows[0]) throw new BusinessSnapshotNotFoundError()
    const snapshot = toSnapshot(existing.rows[0])
    if (snapshot.entityVersion === input.entityVersion && canonicalJson(snapshot.payload) !== canonicalJson(input.payload)) {
      throw new BusinessSnapshotVersionConflictError(workspaceId, input.entityType, input.entityId, input.entityVersion)
    }
    return snapshot
  }

  /** Keeps indexed business tables in sync while the snapshot remains the
   * compatibility recovery source. Both writes use the caller's transaction. */
  private async projectNormalizedInTransaction(client: SqlClient, input: SaveBusinessSnapshotInput): Promise<void> {
    const payload = input.payload
    const json = JSON.stringify(payload)
    if (input.entityType === 'product') {
      await client.query(`INSERT INTO products (id, workspace_id, platform, platform_account_id, store_name, remote_product_id, title, sku_count, stock, price, category, images, attributes, facts_confirmed, source, version, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17::jsonb)
        ON CONFLICT (workspace_id,id) DO UPDATE SET platform=EXCLUDED.platform, platform_account_id=EXCLUDED.platform_account_id, store_name=EXCLUDED.store_name, remote_product_id=EXCLUDED.remote_product_id, title=EXCLUDED.title, sku_count=EXCLUDED.sku_count, stock=EXCLUDED.stock, price=EXCLUDED.price, category=EXCLUDED.category, images=EXCLUDED.images, attributes=EXCLUDED.attributes, facts_confirmed=EXCLUDED.facts_confirmed, source=EXCLUDED.source, version=EXCLUDED.version, data=EXCLUDED.data, updated_at=now()
        WHERE products.version < EXCLUDED.version`, [input.entityId, input.workspaceId, string(payload.platform), stringOrNull(payload.accountId), string(payload.storeName), stringOrNull(payload.remoteId), string(payload.title), integer(payload.skuCount), integer(payload.stock), numberOrNull(payload.price), stringOrNull(payload.category), JSON.stringify(arrayOrEmpty(payload.images)), JSON.stringify(objectOrEmpty(payload.attributes)), payload.factsConfirmed === true, string(payload.source) || 'fixture', positiveInteger(payload.version, input.entityVersion), json])
      return
    }
    if (input.entityType === 'task') {
      await client.query(`INSERT INTO tasks (id, workspace_id, product_id, platform, platform_account_id, state, selected_direction_id, current_content_version_id, version, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        ON CONFLICT (workspace_id,id) DO UPDATE SET product_id=EXCLUDED.product_id, platform=EXCLUDED.platform, platform_account_id=EXCLUDED.platform_account_id, state=EXCLUDED.state, selected_direction_id=EXCLUDED.selected_direction_id, current_content_version_id=EXCLUDED.current_content_version_id, version=EXCLUDED.version, data=EXCLUDED.data, updated_at=now()
        WHERE tasks.version < EXCLUDED.version`, [input.entityId, input.workspaceId, string(payload.productId), string(payload.platform), stringOrNull(payload.accountId), string(payload.state) || 'draft', stringOrNull(payload.selectedDirectionId), stringOrNull(payload.contentVersionId), input.entityVersion, json])
      return
    }
    if (input.entityType === 'content_version') {
      await client.query(`INSERT INTO content_versions (id, workspace_id, task_id, parent_id, version, body, fact_version_ids, rule_version_ids, state, created_by, data)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb)
        ON CONFLICT (workspace_id,id) DO UPDATE SET parent_id=EXCLUDED.parent_id, version=EXCLUDED.version, body=EXCLUDED.body, fact_version_ids=EXCLUDED.fact_version_ids, rule_version_ids=EXCLUDED.rule_version_ids, state=EXCLUDED.state, created_by=EXCLUDED.created_by, data=EXCLUDED.data`, [input.entityId, input.workspaceId, string(payload.taskId), stringOrNull(payload.parentId), positiveInteger(payload.version, 1), JSON.stringify(objectOrEmpty(payload.body)), JSON.stringify(arrayOrEmpty(payload.factVersionIds)), JSON.stringify(arrayOrEmpty(payload.ruleVersionIds)), string(payload.state) || 'draft', string(payload.createdBy) || 'system', json])
      return
    }
    if (input.entityType === 'publish_job') {
      await client.query(`INSERT INTO publish_jobs (id, workspace_id, task_id, content_version_id, platform, platform_account_id, idempotency_key, confirmation_hash, remote_snapshot_hash, state, remote_id, request_id, remote_observed_at, remote_state, remote_simulated, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
        ON CONFLICT (workspace_id,id) DO UPDATE SET state=EXCLUDED.state, remote_id=EXCLUDED.remote_id, request_id=EXCLUDED.request_id, remote_observed_at=EXCLUDED.remote_observed_at, remote_state=EXCLUDED.remote_state, remote_simulated=EXCLUDED.remote_simulated, data=EXCLUDED.data, updated_at=now()`, [input.entityId, input.workspaceId, string(payload.taskId), string(payload.contentVersionId), string(payload.platform), stringOrNull(payload.accountId), string(payload.idempotencyKey), string(payload.confirmationHash), string(payload.remoteSnapshotHash), string(payload.state) || 'queued', stringOrNull(payload.remoteId), stringOrNull(payload.requestId), stringOrNull(payload.remoteObservedAt), stringOrNull(payload.remoteState), payload.remoteSimulated === true, json])
      return
    }
    if (input.entityType === 'platform_account') {
      await client.query(`INSERT INTO platform_accounts (id, workspace_id, platform, remote_account_id, credential_ref, token_state, store_alias, authorization_revision, granted_scopes, access_token_expires_at, credential_refreshable, last_authorized_at, credential_metadata_observed_at, token_state_updated_at, revoked_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (workspace_id,id) DO UPDATE SET remote_account_id=EXCLUDED.remote_account_id, credential_ref=EXCLUDED.credential_ref, token_state=EXCLUDED.token_state, store_alias=EXCLUDED.store_alias, authorization_revision=EXCLUDED.authorization_revision, granted_scopes=EXCLUDED.granted_scopes, access_token_expires_at=EXCLUDED.access_token_expires_at, credential_refreshable=EXCLUDED.credential_refreshable, last_authorized_at=EXCLUDED.last_authorized_at, credential_metadata_observed_at=EXCLUDED.credential_metadata_observed_at, token_state_updated_at=EXCLUDED.token_state_updated_at, revoked_at=EXCLUDED.revoked_at`, [input.entityId, input.workspaceId, string(payload.platform), string(payload.remoteAccountId), string(payload.credentialRef), string(payload.tokenState) || 'connected', stringOrNull(payload.storeAlias), positiveInteger(payload.authRevision, 1), payload.grantedScopes === undefined ? null : JSON.stringify(arrayOrEmpty(payload.grantedScopes)), stringOrNull(payload.accessTokenExpiresAt), typeof payload.credentialRefreshable === 'boolean' ? payload.credentialRefreshable : null, stringOrNull(payload.lastAuthorizedAt), stringOrNull(payload.credentialMetadataObservedAt), stringOrNull(payload.tokenStateUpdatedAt), stringOrNull(payload.revokedAt)])
      return
    }
    if (input.entityType === 'generation_job') {
      await client.query(`INSERT INTO generation_jobs (id, workspace_id, task_id, idempotency_key, state, attempt, content_version_id, error_code, error_message, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        ON CONFLICT (workspace_id,id) DO UPDATE SET state=EXCLUDED.state, attempt=EXCLUDED.attempt, content_version_id=EXCLUDED.content_version_id, error_code=EXCLUDED.error_code, error_message=EXCLUDED.error_message, data=EXCLUDED.data, updated_at=now()`, [input.entityId, input.workspaceId, string(payload.taskId), string(payload.idempotencyKey), string(payload.state) || 'queued', integer(payload.attempt), stringOrNull(payload.contentVersionId), stringOrNull(payload.errorCode), stringOrNull(payload.errorMessage), json])
      return
    }
    if (input.entityType === 'image_generation_job') {
      await client.query(`INSERT INTO image_generation_jobs (id, workspace_id, product_id, task_id, content_version_id, idempotency_key, intent_hash, source_product_version, direction, requested_count, state, artifact_role, archive_state, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'candidate',$12,$13::jsonb)
        ON CONFLICT (workspace_id,id) DO UPDATE SET state=EXCLUDED.state, archive_state=EXCLUDED.archive_state, data=EXCLUDED.data, updated_at=now()`, [input.entityId, input.workspaceId, string(payload.productId), stringOrNull(payload.taskId), stringOrNull(payload.contentVersionId), string(payload.idempotencyKey), string(payload.intentHash), positiveInteger(payload.sourceProductVersion, 1), string(payload.direction), positiveInteger(payload.count, 1), string(payload.state) || 'queued', string(payload.archiveState) || 'pending', json])
      return
    }
    if (input.entityType === 'feedback') {
      await client.query(`INSERT INTO task_feedback (id, workspace_id, task_id, content_version_id, rating, reason, comment, actor_id, created_at, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()),$10::jsonb)
        ON CONFLICT (workspace_id,id) DO UPDATE SET content_version_id=EXCLUDED.content_version_id, rating=EXCLUDED.rating, reason=EXCLUDED.reason, comment=EXCLUDED.comment, actor_id=EXCLUDED.actor_id, data=EXCLUDED.data`, [input.entityId, input.workspaceId, string(payload.taskId), stringOrNull(payload.contentVersionId), string(payload.rating), stringOrNull(payload.reason), stringOrNull(payload.comment), string(payload.actorId) || 'system', stringOrNull(payload.createdAt), json])
    }
  }

  async loadWorkspace(workspaceId: string): Promise<BusinessSnapshot[]> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<BusinessSnapshotRow>(
        `SELECT workspace_id, entity_type, entity_id, entity_version, payload, created_at, updated_at
           FROM business_entity_snapshots
          WHERE workspace_id = $1
          ORDER BY entity_type ASC, entity_id ASC`,
        [scope],
      )
      return result.rows.map(toSnapshot)
    })
  }

  async get(workspaceId: string, entityType: BusinessEntityType, entityId: string): Promise<BusinessSnapshot> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<BusinessSnapshotRow>(
        `SELECT workspace_id, entity_type, entity_id, entity_version, payload, created_at, updated_at
           FROM business_entity_snapshots
          WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3
          LIMIT 1`,
        [scope, entityType, entityId],
      )
      if (!result.rows[0]) throw new BusinessSnapshotNotFoundError()
      return toSnapshot(result.rows[0])
    })
  }

  async findByIdempotencyKey(workspaceId: string, entityType: 'publish_job' | 'generation_job' | 'image_generation_job', idempotencyKey: string): Promise<BusinessSnapshot | undefined> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<BusinessSnapshotRow>(
        `SELECT workspace_id, entity_type, entity_id, entity_version, payload, created_at, updated_at
           FROM business_entity_snapshots
          WHERE workspace_id = $1 AND entity_type = $2 AND payload->>'idempotencyKey' = $3
          ORDER BY updated_at DESC
          LIMIT 1`,
        [scope, entityType, idempotencyKey],
      )
      return result.rows[0] ? toSnapshot(result.rows[0]) : undefined
    })
  }
}

function string(value: unknown): string { return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value) }
function stringOrNull(value: unknown): string | null { const result = string(value); return result || null }
function integer(value: unknown): number { const result = Number(value); return Number.isInteger(result) && result >= 0 ? result : 0 }
function positiveInteger(value: unknown, fallback: number): number { const result = Number(value); return Number.isInteger(result) && result > 0 ? result : Math.max(1, fallback) }
function numberOrNull(value: unknown): number | null { const result = Number(value); return typeof value === 'number' && Number.isFinite(result) ? result : null }
function arrayOrEmpty(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function objectOrEmpty(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
