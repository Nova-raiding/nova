import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, withWorkspaceTransaction, type SqlClient, type SqlPool } from './repository.js'

export interface ScopedBrandBindings {
  accountIds: ReadonlySet<string>
  seriesKeysByAccount: ReadonlyMap<string, ReadonlySet<string>>
  assetIds: ReadonlySet<string>
  imageAssetIds: ReadonlySet<string>
  usableReferenceAssetIds: ReadonlySet<string>
}

export interface ScopedBrandSettingsRecord {
  workspaceId: string
  settings: Record<string, unknown>
  revision: number
  updatedByActorId: string
  updatedAt: string
}

export class ScopedBrandRevisionConflictError extends Error {
  readonly code = 'BRAND_SCOPED_SETTINGS_REVISION_CONFLICT'
  constructor() { super('品牌配置已被其他操作更新，请重新读取后再保存') }
}

export class ScopedBrandBindingError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

type SettingsRow = { workspace_id: string; settings: Record<string, unknown>; revision: string | number; updated_by_actor_id: string; updated_at: Date | string }
type SeriesRow = { id: string; workspace_id: string; platform_account_id: string; name: string; revision: string | number }
type AssignmentRow = { workspace_id: string; asset_id: string; platform_account_id: string; series_id: string | null; revision: string | number }
type AssetRow = { entity_id: string; payload: Record<string, unknown>; trusted_clean: boolean }

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : String(value)
const record = (row: SettingsRow): ScopedBrandSettingsRecord => ({ workspaceId: row.workspace_id, settings: row.settings, revision: Number(row.revision), updatedByActorId: row.updated_by_actor_id, updatedAt: iso(row.updated_at) })
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const keys = (value: unknown): string[] => object(value) ? Object.keys(value) : []
const safeActor = (actorId: string) => {
  const value = actorId.trim()
  if (!value || value.length > 255 || /[\u0000-\u001f]/u.test(value)) throw new ScopedBrandBindingError('BRAND_SCOPE_ACTOR_INVALID', '操作人无效')
  return value
}
const expectedRevision = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new ScopedBrandBindingError('BRAND_SCOPE_REVISION_INVALID', '品牌配置修订号无效')
  return value
}

/**
 * This repository owns tenant-scoped series and asset identities. The caller's
 * parser runs inside the same transaction, against locked server bindings.
 * Generation must still revalidate asset readiness when it freezes a task.
 */
export class PostgresScopedBrandSettingsRepository {
  constructor(private readonly pool: SqlPool) {}

  async get(workspaceId: string): Promise<ScopedBrandSettingsRecord | undefined> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<SettingsRow>('SELECT workspace_id, settings, revision, updated_by_actor_id, updated_at FROM merchant_brand_scoped_settings WHERE workspace_id=$1', [scope])
      return result.rows[0] ? record(result.rows[0]) : undefined
    })
  }

  async listSeries(workspaceId: string, accountId?: string): Promise<Array<{ id: string; accountId: string; name: string; revision: number }>> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const rows = await client.query<SeriesRow>(`SELECT id, workspace_id, platform_account_id, name, revision FROM merchant_brand_series
        WHERE workspace_id=$1 AND ($2::text IS NULL OR platform_account_id=$2) ORDER BY name, id`, [scope, accountId ?? null])
      return rows.rows.map(row => ({ id: row.id, accountId: row.platform_account_id, name: row.name, revision: Number(row.revision) }))
    })
  }

  async createSeries(input: { workspaceId: string; accountId: string; name: string }): Promise<{ id: string; accountId: string; name: string; revision: number }> {
    const scope = requireWorkspaceScope(input.workspaceId)
    const name = input.name.trim()
    if (!name || name.length > 160) throw new ScopedBrandBindingError('BRAND_SERIES_NAME_INVALID', '系列名称无效')
    const id = `series_${randomUUID()}`
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const rows = await client.query<SeriesRow>(`INSERT INTO merchant_brand_series(workspace_id,id,platform_account_id,name)
        VALUES ($1,$2,$3,$4) RETURNING id,workspace_id,platform_account_id,name,revision`, [scope, id, input.accountId, name])
      if (!rows.rows[0]) throw new ScopedBrandBindingError('BRAND_SERIES_CREATE_FAILED', '创建系列失败')
      return { id: rows.rows[0].id, accountId: rows.rows[0].platform_account_id, name: rows.rows[0].name, revision: Number(rows.rows[0].revision) }
    })
  }

  async assignAsset(input: { workspaceId: string; assetId: string; accountId: string; seriesId?: string | null; expectedRevision: number }): Promise<{ assetId: string; accountId: string; seriesId: string | null; revision: number }> {
    const scope = requireWorkspaceScope(input.workspaceId)
    const expected = expectedRevision(input.expectedRevision)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const rows = await client.query<AssignmentRow>(`INSERT INTO merchant_brand_asset_assignments(workspace_id,asset_id,platform_account_id,series_id)
        SELECT $1,$2,$3,$4 FROM business_entity_snapshots asset
         WHERE asset.workspace_id=$1 AND asset.entity_type='asset' AND asset.entity_id=$2
        ON CONFLICT (workspace_id,asset_id) DO UPDATE SET
          platform_account_id=EXCLUDED.platform_account_id,
          series_id=EXCLUDED.series_id,
          revision=merchant_brand_asset_assignments.revision+1,
          updated_at=now()
        WHERE merchant_brand_asset_assignments.revision=$5
        RETURNING workspace_id,asset_id,platform_account_id,series_id,revision`, [scope, input.assetId, input.accountId, input.seriesId ?? null, expected])
      if (!rows.rows[0]) {
        if (expected === 0) throw new ScopedBrandBindingError('BRAND_ASSET_NOT_FOUND', '素材不存在或已归属其他店铺')
        throw new ScopedBrandRevisionConflictError()
      }
      if (expected !== 0 && Number(rows.rows[0].revision) === 1) throw new ScopedBrandRevisionConflictError()
      return { assetId: rows.rows[0].asset_id, accountId: rows.rows[0].platform_account_id, seriesId: rows.rows[0].series_id, revision: Number(rows.rows[0].revision) }
    })
  }

  async getAssetAssignment(workspaceId: string, assetId: string): Promise<{ assetId: string; accountId: string; seriesId: string | null; revision: number } | undefined> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<AssignmentRow>('SELECT workspace_id,asset_id,platform_account_id,series_id,revision FROM merchant_brand_asset_assignments WHERE workspace_id=$1 AND asset_id=$2', [scope, assetId])
      const row = result.rows[0]
      return row ? { assetId: row.asset_id, accountId: row.platform_account_id, seriesId: row.series_id, revision: Number(row.revision) } : undefined
    })
  }

  async listAssetAssignments(workspaceId: string): Promise<Array<{ assetId: string; accountId: string; seriesId: string | null; revision: number }>> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<AssignmentRow>('SELECT workspace_id,asset_id,platform_account_id,series_id,revision FROM merchant_brand_asset_assignments WHERE workspace_id=$1 ORDER BY asset_id', [scope])
      return result.rows.map(row => ({ assetId: row.asset_id, accountId: row.platform_account_id, seriesId: row.series_id, revision: Number(row.revision) }))
    })
  }

  async resolveForTask<T extends object>(input: {
    workspaceId: string
    accountId?: string
    selectedAssetIds: readonly string[]
    validate: (value: unknown, bindings: ScopedBrandBindings) => T
  }): Promise<{ settings: T; revision: number; context: { accountId?: string; seriesKey?: string; assetId?: string } } | undefined> {
    const scope = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<SettingsRow>('SELECT workspace_id,settings,revision,updated_by_actor_id,updated_at FROM merchant_brand_scoped_settings WHERE workspace_id=$1', [scope])
      const row = result.rows[0]
      if (!row) return undefined
      const bindings = await this.loadBindings(client, scope, row.settings)
      const settings = input.validate(row.settings, bindings)
      const context: { accountId?: string; seriesKey?: string; assetId?: string } = input.accountId ? { accountId: input.accountId } : {}
      const selected = [...new Set(input.selectedAssetIds.filter(Boolean))]
      if (selected.length && input.accountId) {
        const assignments = await client.query<AssignmentRow>('SELECT workspace_id,asset_id,platform_account_id,series_id,revision FROM merchant_brand_asset_assignments WHERE workspace_id=$1 AND asset_id=ANY($2::text[]) FOR SHARE', [scope, selected])
        for (const assignment of assignments.rows) {
          if (assignment.platform_account_id !== input.accountId) throw new ScopedBrandBindingError('BRAND_SCOPE_STORE_MISMATCH', '所选素材与任务店铺不一致')
        }
        if (selected.length === 1 && assignments.rows[0]) {
          context.assetId = assignments.rows[0].asset_id
          if (assignments.rows[0].series_id) context.seriesKey = assignments.rows[0].series_id
        }
      }
      return { settings, revision: Number(row.revision), context }
    })
  }

  async save<T extends object>(input: {
    workspaceId: string
    settings: unknown
    expectedRevision: number
    actorId: string
    validate: (value: unknown, bindings: ScopedBrandBindings) => T
  }): Promise<ScopedBrandSettingsRecord> {
    const scope = requireWorkspaceScope(input.workspaceId)
    const expected = expectedRevision(input.expectedRevision)
    const actor = safeActor(input.actorId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const bindings = await this.loadBindings(client, scope, input.settings)
      const validated = input.validate(input.settings, bindings)
      const result = await client.query<SettingsRow>(`INSERT INTO merchant_brand_scoped_settings(workspace_id,settings,updated_by_actor_id)
        VALUES ($1,$2::jsonb,$3)
        ON CONFLICT (workspace_id) DO UPDATE SET
          settings=EXCLUDED.settings,
          revision=merchant_brand_scoped_settings.revision+1,
          updated_by_actor_id=EXCLUDED.updated_by_actor_id,
          updated_at=now()
        WHERE merchant_brand_scoped_settings.revision=$4
        RETURNING workspace_id,settings,revision,updated_by_actor_id,updated_at`, [scope, JSON.stringify(validated), actor, expected])
      if (!result.rows[0] || (expected !== 0 && Number(result.rows[0].revision) === 1)) throw new ScopedBrandRevisionConflictError()
      if (expected === 0 && Number(result.rows[0].revision) !== 1) throw new ScopedBrandRevisionConflictError()
      return record(result.rows[0])
    })
  }

  private async loadBindings(client: SqlClient, workspaceId: string, candidate: unknown): Promise<ScopedBrandBindings> {
    const configuration = object(candidate) ? candidate : {}
    const accountIds = [...new Set([...keys(configuration.stores), ...keys(configuration.series)])]
    const imageAssetIds = keys(configuration.images)
    const referencedAssetIds = new Set(imageAssetIds)
    const visitEntry = (entry: unknown) => {
      if (!object(entry) || !object(entry.values)) return
      for (const key of ['logoAssetId', 'documentAssetId']) if (typeof entry.values[key] === 'string') referencedAssetIds.add(entry.values[key])
    }
    visitEntry(configuration.global)
    if (object(configuration.stores)) for (const entry of Object.values(configuration.stores)) visitEntry(entry)
    if (object(configuration.series)) for (const series of Object.values(configuration.series)) if (object(series)) for (const entry of Object.values(series)) visitEntry(entry)
    if (object(configuration.images)) for (const entry of Object.values(configuration.images)) visitEntry(entry)
    if (accountIds.length > 500 || referencedAssetIds.size > 1000) throw new ScopedBrandBindingError('BRAND_SCOPE_LIMIT', '品牌配置引用数量超过上限')

    const accounts = await client.query<{ id: string }>('SELECT id FROM platform_accounts WHERE workspace_id=$1 AND id=ANY($2::text[]) FOR KEY SHARE', [workspaceId, accountIds])
    const series = await client.query<{ id: string; platform_account_id: string }>('SELECT id,platform_account_id FROM merchant_brand_series WHERE workspace_id=$1 AND platform_account_id=ANY($2::text[]) FOR KEY SHARE', [workspaceId, accountIds])
    const assetIds = [...referencedAssetIds]
    const assets = await client.query<AssetRow>(`SELECT entity_id,payload,asset_snapshot_is_trusted_clean(workspace_id,entity_id,payload) AS trusted_clean
      FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='asset' AND entity_id=ANY($2::text[]) FOR SHARE`, [workspaceId, assetIds])
    const assignments = await client.query<{ asset_id: string }>('SELECT asset_id FROM merchant_brand_asset_assignments WHERE workspace_id=$1 AND asset_id=ANY($2::text[]) FOR KEY SHARE', [workspaceId, imageAssetIds])
    const seriesKeysByAccount = new Map<string, Set<string>>()
    for (const row of series.rows) {
      const set = seriesKeysByAccount.get(row.platform_account_id) ?? new Set<string>()
      set.add(row.id)
      seriesKeysByAccount.set(row.platform_account_id, set)
    }
    const assignedImages = new Set(assignments.rows.map(row => row.asset_id))
    const usableReferenceAssetIds = new Set<string>()
    const imageIds = new Set<string>()
    for (const row of assets.rows) {
      const asset = row.payload
      const image = typeof asset.mimeType === 'string' && asset.mimeType.toLowerCase().startsWith('image/')
      if (image && assignedImages.has(row.entity_id)) imageIds.add(row.entity_id)
      if (row.trusted_clean && asset.scanStatus === 'clean' && asset.scanVerdict === 'clean' && asset.rightsStatus === 'approved' && asset.rightsScope !== 'unusable' && asset.parseStatus === 'succeeded' && asset.factsConfirmedBy && asset.factsConfirmedAt) usableReferenceAssetIds.add(row.entity_id)
    }
    return { accountIds: new Set(accounts.rows.map(row => row.id)), seriesKeysByAccount, assetIds: new Set(assets.rows.map(row => row.entity_id)), imageAssetIds: imageIds, usableReferenceAssetIds }
  }
}
