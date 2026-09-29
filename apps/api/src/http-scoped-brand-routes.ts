import type { IncomingMessage, ServerResponse } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { parseScopedBrandSettings, ScopedBrandSettingsError } from '../../../packages/application/src/scoped-brand-settings.js'
import { PostgresScopedBrandSettingsRepository, ScopedBrandBindingError, ScopedBrandRevisionConflictError } from '../../../packages/persistence/src/scoped-brand-settings-repository.js'
import { DomainError } from '../../../packages/application/src/service.js'

export interface ScopedBrandHttpDependencies {
  repository?: PostgresScopedBrandSettingsRepository
  body(req: IncomingMessage): Promise<Record<string, unknown>>
  resolveWorkspace(req: IncomingMessage, inputWorkspace?: unknown): string
  enforceAccess(req: IncomingMessage, workspaceId: string, write?: boolean): Promise<unknown>
  requireActionableStore(workspaceId: string, accountId: string): void
  actor(req: IncomingMessage): string
  filterActiveAssetIds?: (workspaceId: string, assetIds: readonly string[]) => Promise<ReadonlySet<string>>
  assertAssetActive?: (workspaceId: string, assetId: string) => Promise<void>
  send(res: ServerResponse, status: number, workspaceId: string, value: unknown, error: null, req: IncomingMessage): unknown
}

const fail = (error: unknown): never => {
  if (error instanceof ScopedBrandRevisionConflictError) throw new DomainError(error.code, error.message, 409)
  if (error instanceof ScopedBrandSettingsError || error instanceof ScopedBrandBindingError) throw new DomainError(error.code, error.message, error.code.endsWith('_NOT_FOUND') ? 404 : 400)
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === '23503') throw new DomainError('BRAND_SCOPE_REFERENCE_NOT_FOUND', '店铺、系列或素材不属于当前工作区', 404)
    if (error.code === '23505') throw new DomainError('BRAND_SCOPE_ALREADY_EXISTS', '同一店铺已有同名系列或配置', 409)
  }
  throw error
}

const entries = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** The route is unreachable until the API composition root injects a durable repository. */
export async function routeScopedBrandHttp(req: IncomingMessage, res: ServerResponse, path: string, dependencies: ScopedBrandHttpDependencies): Promise<boolean> {
  const assetMatch = /^\/v1\/brand-scopes\/assets\/([^/]+)\/assignment$/u.exec(path)
  if (path !== '/v1/brand-scopes' && path !== '/v1/brand-scopes/series' && !assetMatch) return false
  const { repository, body, resolveWorkspace, enforceAccess, actor, send } = dependencies
  if (!repository) throw new DomainError('BRAND_SCOPES_NOT_CONFIGURED', '品牌配置服务尚未启用', 503)
  if (req.method === 'GET' && path === '/v1/brand-scopes') {
    const workspaceId = resolveWorkspace(req)
    await enforceAccess(req, workspaceId)
    const [record, series, rawAssignments] = await Promise.all([
      repository.get(workspaceId), repository.listSeries(workspaceId), repository.listAssetAssignments(workspaceId),
    ])
    const activeIds = dependencies.filterActiveAssetIds ? await dependencies.filterActiveAssetIds(workspaceId, rawAssignments.map(row => row.assetId)) : undefined
    const assignments = activeIds ? rawAssignments.filter(row => activeIds.has(row.assetId)) : rawAssignments
    send(res, 200, workspaceId, { settings: record?.settings ?? { schemaVersion: 1 }, revision: record?.revision ?? 0, updated_at: record?.updatedAt ?? null, series, assignments }, null, req)
    return true
  }
  if (req.method === 'PUT' && path === '/v1/brand-scopes') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    await enforceAccess(req, workspaceId, true)
    if (!Number.isSafeInteger(input.expected_revision) || Number(input.expected_revision) < 0) throw new DomainError('BRAND_SCOPE_REVISION_REQUIRED', '请先读取品牌配置修订号再保存', 400)
    const settings = entries(input.settings)
    const previous = entries((await repository.get(workspaceId))?.settings)
    const changedStores = new Set<string>()
    for (const key of ['stores', 'series']) {
      const candidate = entries(settings[key])
      const prior = entries(previous[key])
      for (const [accountId, value] of Object.entries(candidate)) {
        if (!isDeepStrictEqual(value, prior[accountId])) changedStores.add(accountId)
      }
    }
    for (const [assetId, value] of Object.entries(entries(settings.images))) {
      if (isDeepStrictEqual(value, entries(previous.images)[assetId])) continue
      await dependencies.assertAssetActive?.(workspaceId, assetId)
      const assignment = await repository.getAssetAssignment(workspaceId, assetId)
      if (assignment) changedStores.add(assignment.accountId)
    }
    for (const accountId of changedStores) dependencies.requireActionableStore(workspaceId, accountId)
    try {
      const record = await repository.save({ workspaceId, settings: input.settings, expectedRevision: Number(input.expected_revision), actorId: actor(req), validate: parseScopedBrandSettings })
      send(res, 200, workspaceId, record, null, req)
      return true
    } catch (error) { fail(error) }
  }
  if (req.method === 'POST' && path === '/v1/brand-scopes/series') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    await enforceAccess(req, workspaceId, true)
    if (typeof input.account_id !== 'string' || !input.account_id.trim() || typeof input.name !== 'string' || !input.name.trim()) throw new DomainError('BRAND_SERIES_INPUT_INVALID', '店铺和系列名称不能为空', 400)
    dependencies.requireActionableStore(workspaceId, input.account_id)
    try {
      const series = await repository.createSeries({ workspaceId, accountId: input.account_id, name: input.name })
      send(res, 201, workspaceId, series, null, req)
      return true
    } catch (error) { fail(error) }
  }
  if (req.method === 'PUT' && assetMatch) {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    await enforceAccess(req, workspaceId, true)
    if (typeof input.account_id !== 'string' || !input.account_id.trim() || !Number.isSafeInteger(input.expected_revision) || Number(input.expected_revision) < 0) throw new DomainError('BRAND_ASSET_ASSIGNMENT_INVALID', '请选择店铺并提供当前归属修订号', 400)
    if (input.series_id !== undefined && input.series_id !== null && (typeof input.series_id !== 'string' || !input.series_id.trim())) throw new DomainError('BRAND_ASSET_ASSIGNMENT_INVALID', '系列标识无效', 400)
    dependencies.requireActionableStore(workspaceId, input.account_id)
    const assetId = decodeURIComponent(assetMatch[1]!)
    await dependencies.assertAssetActive?.(workspaceId, assetId)
    try {
      const assignment = await repository.assignAsset({ workspaceId, assetId, accountId: input.account_id, seriesId: typeof input.series_id === 'string' ? input.series_id : null, expectedRevision: Number(input.expected_revision) })
      send(res, 200, workspaceId, assignment, null, req)
      return true
    } catch (error) { fail(error) }
  }
  throw new DomainError('METHOD_NOT_ALLOWED', '品牌配置接口不支持此操作', 405)
}
