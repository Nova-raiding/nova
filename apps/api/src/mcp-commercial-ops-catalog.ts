import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES, type CapabilityId } from '../../../packages/contracts/src/index.js'
import { CommercialCatalogUnavailableError, CommercialCatalogConflictError, type CommercialCatalogMutationInput } from '../../../packages/persistence/src/commercial-catalog-repository.js'
import { authorizeCommercialCatalogRead, paginateCommercialRows, projectCommercialCatalogItem, projectCommercialOpsCapabilities } from './ops/commercial-ops-read-model.js'
import type { ApiPersistence } from './server.js'

type Params = Record<string, unknown>

export interface CommercialOpsCatalogDependencies {
  catalog: NonNullable<ApiPersistence['commercialCatalog']> | undefined
  capabilities(): CapabilityId[]
  actor(): string
  required(params: Params, key: string): string
  parseJsonObjectParameter(params: Params, key: string): Record<string, unknown>
  parseJsonArrayParameter(params: Params, key: string): unknown[]
  commercialOpsReadInput<T>(project: () => T): T
}

export async function handleCommercialOpsCatalogMethod(method: string, params: Params, deps: CommercialOpsCatalogDependencies): Promise<Record<string, unknown>> {
  const { catalog, capabilities, actor, required, parseJsonObjectParameter, parseJsonArrayParameter, commercialOpsReadInput } = deps
  if (!catalog) throw new DomainError('COMMERCIAL_CATALOG_REPOSITORY_UNAVAILABLE', 'V2 商业目录仓储未配置', 503)
  if (method === 'ops.commercial.catalog-v2.list') {
    const allowedKinds = ['onboarding', 'monthly', 'point_pack', 'private_trial'] as const
    const allowedSaleStates = ['unlisted', 'on_sale', 'off_sale', 'archived', 'deleted'] as const
    if (params.kind !== undefined && (typeof params.kind !== 'string' || !allowedKinds.includes(params.kind as typeof allowedKinds[number]))) {
      throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'kind 无效', 400, { field_errors: { kind: '请选择支持的商品类别' } })
    }
    if (params.sale_state !== undefined && (typeof params.sale_state !== 'string' || !allowedSaleStates.includes(params.sale_state as typeof allowedSaleStates[number]))) {
      throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'sale_state 无效', 400, { field_errors: { sale_state: '请选择支持的上架状态' } })
    }
    if (params.search !== undefined && typeof params.search !== 'string') {
      throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'search 无效', 400, { field_errors: { search: '请输入文本' } })
    }
    const capabilityProjection = projectCommercialOpsCapabilities(capabilities())
    const catalogAuthorization = authorizeCommercialCatalogRead(params.include_private, capabilityProjection)
    const rows = await catalog.list(catalogAuthorization.repositoryOptions)
    // The repository read is already visibility-scoped. Apply the declared
    // filters before pagination so total and cursor describe the same result set.
    const search = typeof params.search === 'string' ? params.search.trim().toLocaleLowerCase() : ''
    const filteredRows = rows.map(projectCommercialCatalogItem).filter(item => {
      if (typeof params.kind === 'string' && item.type !== params.kind) return false
      if (typeof params.sale_state === 'string' && item.sale_state !== params.sale_state) return false
      if (search) {
        const description = typeof item.payload.description === 'string' ? item.payload.description : ''
        if (![item.sku_code, item.name, description].some(value => value.toLocaleLowerCase().includes(search))) return false
      }
      return true
    })
    const page = commercialOpsReadInput(() => paginateCommercialRows(filteredRows, { kind: 'catalog', cursor: params.cursor, limit: params.limit }))
    return { schema_version: 'commercial.catalog.v2', items: page.items, total: page.total, next_cursor: page.nextCursor, private_entries_included: catalogAuthorization.privateEntriesIncluded }
  }
  const actions = ['create', 'submit', 'approve', 'reject', 'publish', 'retire', 'archive', 'delete_draft'] as const
  const action = actions.find(value => value === params.action)
  if (!action) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'action 无效', 400, { field_errors: { action: '请选择支持的目录操作' } })
  const capability = action === 'approve' || action === 'reject' ? 'commercial.catalog.approve'
    : action === 'publish' || action === 'retire' || action === 'archive' ? 'commercial.catalog.publish'
    : 'commercial.catalog.draft'
  if (!(capabilities() as readonly string[]).includes(capability)) {
    throw new DomainError('FORBIDDEN', '当前账号没有该目录操作权限', 403, { required_capability: capability })
  }
  const revisionText = required(params, 'expected_revision')
  if (!/^\d+$/u.test(revisionText) || !Number.isSafeInteger(Number(revisionText))) {
    throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_revision 必须是非负整数', 400)
  }
  const payload = params.payload_json ? parseJsonObjectParameter(params, 'payload_json') : {}
  if (typeof params.family === 'string') payload.planFamily = params.family
  if (typeof params.tier_rank === 'string') {
    if (!/^[1-9]\d*$/u.test(params.tier_rank) || !Number.isSafeInteger(Number(params.tier_rank))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'tier_rank 无效', 400)
    payload.tierRank = Number(params.tier_rank)
  }
  if (params.cycle_json) payload.cycle = parseJsonObjectParameter(params, 'cycle_json')
  if (params.bundle_refs_json) payload.bundleRefs = parseJsonArrayParameter(params, 'bundle_refs_json')
  const input: CommercialCatalogMutationInput = {
    action,
    expectedRevision: Number(revisionText),
    idempotencyKey: required(params, 'idempotency_key'),
    ...(typeof params.version_id === 'string' ? { versionId: params.version_id } : {}),
    code: required(params, 'code'),
    ...(typeof params.kind === 'string' ? { kind: params.kind as CommercialCatalogMutationInput['kind'] } : {}),
    ...(typeof params.visibility === 'string' ? { visibility: params.visibility as CommercialCatalogMutationInput['visibility'] } : {}),
    ...(typeof params.required_capability === 'string' ? { requiredCapability: params.required_capability } : {}),
    ...(typeof params.price_fen === 'string' ? { priceFen: Number(params.price_fen) } : {}),
    ...(typeof params.price_mode === 'string' ? { priceMode: params.price_mode as CommercialCatalogMutationInput['priceMode'] } : {}),
    ...(typeof params.duration_days === 'string' ? { durationDays: Number(params.duration_days) } : {}),
    ...(Object.keys(payload).length ? { payload } : {}),
    ...(params.benefits_json ? { benefits: parseJsonArrayParameter(params, 'benefits_json') as NonNullable<CommercialCatalogMutationInput['benefits']> } : {}),
    actorId: actor(),
    reason: required(params, 'reason'),
    evidence: parseJsonObjectParameter(params, 'evidence_json'),
  }
  if (input.priceFen !== undefined && (input.priceFen === null || !Number.isSafeInteger(input.priceFen) || input.priceFen < 0)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'price_fen 无效', 400)
  try {
    const item = await catalog.mutate(input)
    return { schema_version: 'commercial.catalog.v2', item: projectCommercialCatalogItem(item) }
  } catch (error) {
    if (error instanceof CommercialCatalogConflictError) throw new DomainError(error.code, error.message, 409, { business_reason: 'catalog_revision_or_idempotency_conflict', retryable: false, next_actions: ['ops.commercial.catalog-v2.list'] })
    if (error instanceof CommercialCatalogUnavailableError) throw new DomainError(error.code, error.message, 409)
    throw error
  }
}
