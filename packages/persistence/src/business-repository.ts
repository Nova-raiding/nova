import { randomUUID } from 'node:crypto'
import { withWorkspaceTransaction, requireWorkspaceScope, type SqlClient, type SqlPool } from './repository.js'

export type BusinessEntityType = 'product' | 'task' | 'content_version' | 'publish_job' | 'publish_batch' | 'platform_account' | 'generation_job' | 'image_generation_job' | 'brand_profile' | 'asset' | 'feedback' | 'sync_job' | 'automation_policy' | 'merchant_intent'

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

export interface BusinessPage<T extends Record<string, unknown> = Record<string, unknown>> {
  items: T[]
  total: number
  limit: number
  offset: number
}

export interface ProductAssetBindingRow {
  workspaceId: string
  productId: string
  assetId: string
  assetRole: 'source' | 'main' | 'secondary' | 'detail'
  ordinal: number
  status: 'active' | 'disabled'
  createdAt: string
  updatedAt: string
}

export interface ProductAssetBindingChangeInput {
  workspaceId: string
  productId: string
  assetId: string
  assetRole: ProductAssetBindingRow['assetRole']
  ordinal?: number
  expectedVersion: number
  brandId?: string
  actorId: string
  reason: string
}

export interface ProductPageInput extends Record<string, unknown> {
  query?: string; platform?: string; accountId?: string; storeName?: string; brandName?: string; skuId?: string
  remoteProductId?: string; listingStatus?: string; productState?: 'active' | 'disabled'; syncStatus?: string
  factsConfirmed?: boolean; dateFrom?: string; dateTo?: string; accessibleBrandIds?: readonly string[]; limit: number; offset: number
}

export interface TaskPageInput extends Record<string, unknown> {
  query?: string; platform?: string; state?: string; productId?: string; accountId?: string; brandName?: string
  storeName?: string; remoteProductId?: string; publishStatus?: string; dateFrom?: string; dateTo?: string
  accessibleBrandIds?: readonly string[]; limit: number; offset: number
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
      await client.query(`INSERT INTO tasks (id, workspace_id, product_id, platform, platform_account_id, brand_id, canonical_product_id, listing_id, campaign_id, campaign_item_id, state, selected_direction_id, current_content_version_id, version, data)
        VALUES ($1,$2,$3,$4,$5,
          CASE WHEN $6::text IS NOT NULL AND EXISTS (
            SELECT 1 FROM brands WHERE workspace_id = $2 AND id = $6::text
          ) THEN $6::text ELSE NULL::text END,
          $7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
        ON CONFLICT (workspace_id,id) DO UPDATE SET product_id=EXCLUDED.product_id, platform=EXCLUDED.platform, platform_account_id=EXCLUDED.platform_account_id, brand_id=EXCLUDED.brand_id, canonical_product_id=EXCLUDED.canonical_product_id, listing_id=EXCLUDED.listing_id, campaign_id=EXCLUDED.campaign_id, campaign_item_id=EXCLUDED.campaign_item_id, state=EXCLUDED.state, selected_direction_id=EXCLUDED.selected_direction_id, current_content_version_id=EXCLUDED.current_content_version_id, version=EXCLUDED.version, data=EXCLUDED.data, updated_at=now()
        WHERE tasks.version < EXCLUDED.version`, [input.entityId, input.workspaceId, string(payload.productId), string(payload.platform), stringOrNull(payload.accountId), stringOrNull(payload.brandId), stringOrNull(payload.canonicalProductId), stringOrNull(payload.listingId), stringOrNull(payload.campaignId), stringOrNull(payload.campaignItemId), string(payload.state) || 'draft', stringOrNull(payload.selectedDirectionId), stringOrNull(payload.contentVersionId), input.entityVersion, json])
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

  async loadWorkspace(workspaceId: string, options: { excludeEntityTypes?: readonly BusinessEntityType[] } = {}): Promise<BusinessSnapshot[]> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const excluded = options.excludeEntityTypes ?? []
      const result = await client.query<BusinessSnapshotRow>(
        `SELECT workspace_id, entity_type, entity_id, entity_version, payload, created_at, updated_at
           FROM business_entity_snapshots
          WHERE workspace_id = $1
            AND NOT (entity_type = ANY($2::text[]))
          ORDER BY entity_type ASC, entity_id ASC`,
        [scope, excluded],
      )
      return result.rows.map(toSnapshot)
    })
  }

  async listProductsPage(workspaceId: string, input: ProductPageInput): Promise<BusinessPage> {
    return this.listNormalizedPage('products', workspaceId, input, 'updated_at DESC, id ASC')
  }

  async listProductAssetBindings(workspaceId: string, input: { productId?: string; assetId?: string; status?: ProductAssetBindingRow['status'] } = {}): Promise<ProductAssetBindingRow[]> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const values: unknown[] = [scope]
      const clauses = ['workspace_id = $1']
      const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)) }
      if (input.productId) add('product_id = ?', input.productId)
      if (input.assetId) add('asset_id = ?', input.assetId)
      if (input.status) add('status = ?', input.status)
      const result = await client.query<{ workspace_id: string; product_id: string; asset_id: string; asset_role: ProductAssetBindingRow['assetRole']; ordinal: number; status: ProductAssetBindingRow['status']; created_at: string | Date; updated_at: string | Date }>(`SELECT workspace_id, product_id, asset_id, asset_role, ordinal, status, created_at, updated_at FROM product_asset_bindings WHERE ${clauses.join(' AND ')} ORDER BY product_id ASC, ordinal ASC, asset_id ASC`, values)
      return result.rows.map(row => ({ workspaceId: row.workspace_id, productId: row.product_id, assetId: row.asset_id, assetRole: row.asset_role, ordinal: row.ordinal, status: row.status, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }))
    })
  }

  async bindProductAsset(input: ProductAssetBindingChangeInput): Promise<ProductAssetBindingRow> {
    return this.changeProductAssetBinding(input, 'active')
  }

  async unbindProductAsset(input: ProductAssetBindingChangeInput): Promise<ProductAssetBindingRow> {
    return this.changeProductAssetBinding(input, 'disabled')
  }

  private async changeProductAssetBinding(input: ProductAssetBindingChangeInput, status: ProductAssetBindingRow['status']): Promise<ProductAssetBindingRow> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    if (!input.productId.trim() || !input.assetId.trim() || !input.actorId.trim() || !input.reason.trim()) throw new Error('PRODUCT_ASSET_BINDING_INPUT_INVALID')
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('PRODUCT_ASSET_BINDING_VERSION_INVALID')
    const ordinal = input.ordinal ?? 1
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error('PRODUCT_ASSET_BINDING_ORDINAL_INVALID')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const productResult = await client.query<BusinessSnapshotRow>(`SELECT workspace_id, entity_type, entity_id, entity_version, payload, created_at, updated_at FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='product' AND entity_id=$2 FOR UPDATE`, [workspaceId, input.productId])
      const product = productResult.rows[0]
      if (!product) throw new BusinessSnapshotNotFoundError()
      if (product.entity_version !== input.expectedVersion) throw new BusinessSnapshotVersionConflictError(workspaceId, 'product', input.productId, input.expectedVersion)
      const productBrandId = typeof product.payload.brandId === 'string' ? product.payload.brandId.trim() : ''
      if (input.brandId?.trim() && productBrandId && input.brandId.trim() !== productBrandId) throw new Error('PRODUCT_ASSET_BINDING_BRAND_MISMATCH')
      const assetResult = await client.query<{ entity_id: string; payload: Record<string, unknown> }>(`SELECT entity_id, payload FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='asset' AND entity_id=$2 FOR SHARE`, [workspaceId, input.assetId])
      const asset = assetResult.rows[0]
      if (!asset) throw new Error('PRODUCT_ASSET_BINDING_ASSET_NOT_FOUND')
      const assetBrandId = typeof asset.payload.brandId === 'string' ? asset.payload.brandId.trim() : ''
      if (input.brandId?.trim() && assetBrandId && assetBrandId !== input.brandId.trim()) throw new Error('PRODUCT_ASSET_BINDING_BRAND_MISMATCH')
      const nextPayload = { ...product.payload }
      if (input.assetRole === 'source') {
        const sourceIds = Array.isArray(nextPayload.sourceAssetIds) ? nextPayload.sourceAssetIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : []
        nextPayload.sourceAssetIds = status === 'active' ? [...new Set([...sourceIds, input.assetId])] : sourceIds.filter(value => value !== input.assetId)
      }
      await this.saveInTransaction(client, { workspaceId, entityType: 'product', entityId: input.productId, entityVersion: input.expectedVersion + 1, payload: nextPayload })
      const relation = await client.query<{ workspace_id: string; product_id: string; asset_id: string; asset_role: ProductAssetBindingRow['assetRole']; ordinal: number; status: ProductAssetBindingRow['status']; created_at: string | Date; updated_at: string | Date }>(`INSERT INTO product_asset_bindings (workspace_id, product_id, asset_id, asset_role, ordinal, status) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id, product_id, asset_id, asset_role) DO UPDATE SET ordinal=EXCLUDED.ordinal, status=EXCLUDED.status, updated_at=now() RETURNING workspace_id, product_id, asset_id, asset_role, ordinal, status, created_at, updated_at`, [workspaceId, input.productId, input.assetId, input.assetRole, ordinal, status])
      const row = relation.rows[0]
      if (!row) throw new Error('PRODUCT_ASSET_BINDING_WRITE_FAILED')
      await client.query(`INSERT INTO workspace_operation_audit (id, workspace_id, actor_id, action, resource_type, resource_id, before_json, after_json, reason) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`, [randomUUID(), workspaceId, input.actorId.trim(), status === 'active' ? 'product.asset.bind' : 'product.asset.unbind', 'product_asset_binding', `${input.productId}:${input.assetId}:${input.assetRole}`, JSON.stringify({ status: status === 'active' ? 'disabled' : 'active', product_version: input.expectedVersion }), JSON.stringify({ status, product_version: input.expectedVersion + 1, brand_id: (input.brandId ?? productBrandId) || null }), input.reason.trim()])
      return { workspaceId: row.workspace_id, productId: row.product_id, assetId: row.asset_id, assetRole: row.asset_role, ordinal: row.ordinal, status: row.status, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }
    })
  }

  async listTasksPage(workspaceId: string, input: TaskPageInput): Promise<BusinessPage> {
    return this.listNormalizedPage('tasks', workspaceId, input, 'created_at DESC, id ASC')
  }

  private async listNormalizedPage(table: 'products' | 'tasks', workspaceId: string, input: ProductPageInput & Partial<TaskPageInput>, orderBy: string): Promise<BusinessPage> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 || !Number.isSafeInteger(input.offset) || input.offset < 0) throw new RangeError('business page limit or offset is invalid')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const clauses = ['workspace_id = $1']
      const values: unknown[] = [scope]
      const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)) }
      if (input.platform) add('platform = ?', input.platform)
      if (table === 'products' && input.accountId) add('platform_account_id = ?', input.accountId)
      if (table === 'products' && input.storeName) add("lower(store_name) LIKE '%' || lower(?) || '%'", input.storeName)
      if (table === 'products' && typeof input.factsConfirmed === 'boolean') add('facts_confirmed = ?', input.factsConfirmed)
      if (table === 'products' && input.brandName) add("lower(coalesce(data#>>'{attributes,brand}', '')) LIKE '%' || lower(?) || '%'", input.brandName)
      if (table === 'products' && input.skuId) add("coalesce(data->'skus', '[]'::jsonb) @> ?::jsonb", JSON.stringify([{ id: input.skuId }]))
      if (table === 'products' && input.remoteProductId) add('remote_product_id = ?', input.remoteProductId)
      if (table === 'products' && input.listingStatus) add("data->>'listingStatus' = ?", input.listingStatus)
      if (table === 'products' && input.productState) clauses.push(input.productState === 'disabled' ? "nullif(data->>'disabledAt', '') IS NOT NULL" : "nullif(data->>'disabledAt', '') IS NULL")
      if (table === 'products' && input.syncStatus) add(`(SELECT state FROM sync_jobs WHERE sync_jobs.workspace_id = products.workspace_id AND sync_jobs.platform = products.platform AND sync_jobs.platform_account_id = products.platform_account_id ORDER BY sync_jobs.updated_at DESC, sync_jobs.id ASC LIMIT 1) = ?`, input.syncStatus)
      if (table === 'products' && Array.isArray(input.accessibleBrandIds)) {
        values.push(input.accessibleBrandIds)
        clauses.push(`EXISTS (SELECT 1 FROM canonical_products WHERE canonical_products.workspace_id = products.workspace_id AND canonical_products.legacy_product_id = products.id AND canonical_products.brand_id = ANY($${values.length}::text[]))`)
      }
      if (table === 'tasks' && input.state) add('state = ?', input.state)
      if (table === 'tasks' && input.productId) add('product_id = ?', input.productId)
      if (table === 'tasks' && input.accountId) add('platform_account_id = ?', input.accountId)
      if (table === 'tasks' && input.brandName) add(`EXISTS (SELECT 1 FROM products WHERE products.workspace_id = tasks.workspace_id AND products.id = tasks.product_id AND lower(coalesce(products.data#>>'{attributes,brand}', '')) LIKE '%' || lower(?) || '%')`, input.brandName)
      if (table === 'tasks' && input.storeName) add(`EXISTS (SELECT 1 FROM products WHERE products.workspace_id = tasks.workspace_id AND products.id = tasks.product_id AND lower(products.store_name) LIKE '%' || lower(?) || '%')`, input.storeName)
      if (table === 'tasks' && input.remoteProductId) add('EXISTS (SELECT 1 FROM products WHERE products.workspace_id = tasks.workspace_id AND products.id = tasks.product_id AND products.remote_product_id = ?)', input.remoteProductId)
      if (table === 'tasks' && input.publishStatus) {
        values.push(input.publishStatus, input.publishStatus)
        const first = values.length - 1
        clauses.push(`(SELECT (publish_jobs.state = $${first} OR publish_jobs.remote_state = $${first + 1}) FROM publish_jobs WHERE publish_jobs.workspace_id = tasks.workspace_id AND publish_jobs.task_id = tasks.id ORDER BY publish_jobs.created_at DESC, publish_jobs.id ASC LIMIT 1) = true`)
      }
      if (table === 'tasks' && Array.isArray(input.accessibleBrandIds)) {
        values.push(input.accessibleBrandIds)
        clauses.push(`brand_id = ANY($${values.length}::text[])`)
      }
      if (input.query) {
        const searchable = table === 'products'
          ? "(lower(id) LIKE '%' || lower(?) || '%' OR lower(title) LIKE '%' || lower(?) || '%' OR lower(coalesce(remote_product_id,'')) LIKE '%' || lower(?) || '%')"
          : "(lower(id) LIKE '%' || lower(?) || '%' OR lower(product_id) LIKE '%' || lower(?) || '%' OR EXISTS (SELECT 1 FROM products WHERE products.workspace_id = tasks.workspace_id AND products.id = tasks.product_id AND lower(products.title) LIKE '%' || lower(?) || '%'))"
        values.push(input.query, input.query, input.query)
        const base = values.length - 2
        clauses.push(searchable.replace('?', `$${base}`).replace('?', `$${base + 1}`).replace('?', `$${base + 2}`))
      }
      if (input.dateFrom) add(`${table === 'products' ? 'updated_at' : 'created_at'} >= ?::timestamptz`, input.dateFrom)
      if (input.dateTo) add(`${table === 'products' ? 'updated_at' : 'created_at'} <= ?::timestamptz`, input.dateTo)
      const where = clauses.join(' AND ')
      const count = await client.query<{ total: number | string }>(`SELECT count(*) AS total FROM ${table} WHERE ${where}`, values)
      const pageValues = [...values, input.limit, input.offset]
      const dataProjection = table === 'tasks'
        ? `data || jsonb_build_object(
            'id', id,
            'workspaceId', workspace_id,
            'productId', product_id,
            'platform', platform,
            'accountId', platform_account_id,
            'state', state,
            'version', version,
            'createdAt', created_at,
            'updatedAt', updated_at
          )`
        : `data || jsonb_build_object(
            'id', id,
            'workspaceId', workspace_id,
            'platform', platform,
            'accountId', platform_account_id,
            'storeName', store_name,
            'remoteId', remote_product_id,
            'title', title,
            'skuCount', sku_count,
            'stock', stock,
            'price', price,
            'category', category,
            'images', images,
            'attributes', attributes,
            'factsConfirmed', facts_confirmed,
            'source', source,
            'version', version,
            'createdAt', created_at,
            'updatedAt', updated_at
          )`
      const page = await client.query<{ data: Record<string, unknown> }>(`SELECT ${dataProjection} AS data FROM ${table} WHERE ${where} ORDER BY ${orderBy} LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`, pageValues)
      return { items: page.rows.map(row => row.data), total: Number(count.rows[0]?.total ?? 0), limit: input.limit, offset: input.offset }
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
