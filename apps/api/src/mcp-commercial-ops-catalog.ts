import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES, type CapabilityId } from '../../../packages/contracts/src/index.js'
import { CommercialCatalogUnavailableError, type CommercialCatalogMutationInput } from '../../../packages/persistence/src/commercial-catalog-repository.js'
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
    const capabilityProjection = projectCommercialOpsCapabilities(capabilities())
    const catalogAuthorization = authorizeCommercialCatalogRead(params.include_private, capabilityProjection)
    const rows = await catalog.list(catalogAuthorization.repositoryOptions)
    if (!rows.length) throw new DomainError('COMMERCIAL_CATALOG_UNAVAILABLE', '没有可读取的 V2 商业目录版本', 503, { catalog: null })
    const page = commercialOpsReadInput(() => paginateCommercialRows(rows.map(projectCommercialCatalogItem), { kind: 'catalog', cursor: params.cursor, limit: params.limit }))
    return { schema_version: 'commercial.catalog.v2', items: page.items, total: page.total, next_cursor: page.nextCursor, private_entries_included: catalogAuthorization.privateEntriesIncluded }
  }
  const action = params.action === 'retire' || params.action === 'create' || params.action === 'approve' || params.action === 'publish' ? params.action : null
  if (!action) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'action 必须是 create、approve、publish 或 retire', 400)
  if (action === 'approve' || action === 'publish' || action === 'retire') {
    if (!(capabilities() as readonly string[]).includes('commercial.catalog.publish')) throw new DomainError('FORBIDDEN', '当前账号没有套餐审批发布权限', 403)
  }
  const input: CommercialCatalogMutationInput = {
    action,
    code: required(params, 'code'),
    ...(typeof params.kind === 'string' ? { kind: params.kind as CommercialCatalogMutationInput['kind'] } : {}),
    ...(typeof params.visibility === 'string' ? { visibility: params.visibility as CommercialCatalogMutationInput['visibility'] } : {}),
    ...(typeof params.required_capability === 'string' ? { requiredCapability: params.required_capability } : {}),
    ...(typeof params.price_fen === 'string' ? { priceFen: Number(params.price_fen) } : {}),
    ...(typeof params.price_mode === 'string' ? { priceMode: params.price_mode as CommercialCatalogMutationInput['priceMode'] } : {}),
    ...(typeof params.duration_days === 'string' ? { durationDays: Number(params.duration_days) } : {}),
    ...(params.payload_json ? { payload: parseJsonObjectParameter(params, 'payload_json') } : {}),
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
    if (error instanceof CommercialCatalogUnavailableError) throw new DomainError(error.code, error.message, 409)
    throw error
  }
}
