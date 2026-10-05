import { DomainError } from '../../../packages/application/src/service.js'
import { CommercialCatalogConflictError, CommercialCatalogUnavailableError, type CommercialCatalogBenefit } from '../../../packages/persistence/src/commercial-catalog-repository.js'
import type { PostgresCommercialBenefitBundleRepository, CommercialBenefitBundleMutationInput } from '../../../packages/persistence/src/commercial-benefit-bundle-repository.js'
import { commercialOpsPageLimit, CommercialOpsReadModelError } from './ops/commercial-ops-read-model.js'
export const MCP_COMMERCIAL_BUNDLE_METHODS = new Set(['ops.commercial.benefit-definitions.list', 'ops.commercial.benefit-bundles.list', 'ops.commercial.benefit-bundles.references.list', 'ops.commercial.benefit-bundles.mutate'])
type Params = Record<string, unknown>
function afterId(value: unknown, kind: string): string | undefined {
  if(value===undefined||value===null||value==='')return undefined
  try {
    if(typeof value!=='string'||value.length>4096)throw new Error('invalid cursor')
    const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'))
    if(parsed.kind!==kind||typeof parsed.afterId!=='string'||!parsed.afterId.trim()||parsed.afterId.length>1024)throw new Error('invalid cursor')
    return parsed.afterId
  }catch{throw new DomainError('COMMERCIAL_OPS_CURSOR_INVALID','权益包分页游标无效',400)}
}
function nextCursor(kind:string,id:string|null){return id?Buffer.from(JSON.stringify({kind,afterId:id})).toString('base64url'):null}

export async function handleCommercialBenefitBundleMethod(method: string, params: Params, deps: {
  repository?: PostgresCommercialBenefitBundleRepository
  actorId: string
  capabilities: readonly string[]
  required(input: Params, key: string): string
  object(input: Params, key: string): Record<string, unknown>
  array(input: Params, key: string): unknown[]
}) {
  const { repository, required } = deps
  if (!repository) throw new DomainError('COMMERCIAL_BUNDLE_REPOSITORY_UNAVAILABLE', '权益定义与权益包仓储未配置', 503)
  try {
    if (method === 'ops.commercial.benefit-definitions.list') return { schema_version: 'commercial.benefit-definitions.v1', items: repository.definitions(), next_cursor: null }
    if (method === 'ops.commercial.benefit-bundles.list') {
      const page = await repository.listPage({code:typeof params.code==='string'?params.code:undefined,search:typeof params.search==='string'?params.search:undefined,limit:commercialOpsPageLimit(params.limit),afterId:afterId(params.cursor,'catalog')})
      return { schema_version: 'commercial.benefit-bundles.v1', items: page.items, total: page.total, next_cursor: nextCursor('catalog',page.nextAfterId) }
    }
    if (method === 'ops.commercial.benefit-bundles.references.list') {
      const page = await repository.referencesPage({code:required(params,'code'),versionId:typeof params.version_id==='string'?params.version_id:undefined,limit:commercialOpsPageLimit(params.limit),afterId:afterId(params.cursor,'bundle_references')})
      return { schema_version: 'commercial.benefit-bundle.references.v1', items: page.items, total: page.total, next_cursor: nextCursor('bundle_references',page.nextAfterId) }
    }
    const actions: CommercialBenefitBundleMutationInput['action'][] = ['create', 'submit', 'approve', 'reject', 'retire', 'archive', 'delete_draft']
    const action = actions.find(value => value === params.action)
    if (!action) throw new DomainError('INVALID_REQUEST', '权益包 action 无效；独立售卖通过对应商品上架', 400)
    const capability = action === 'approve' || action === 'reject' ? 'commercial.catalog.approve' : action === 'retire' || action === 'archive' ? 'commercial.catalog.publish' : 'commercial.catalog.draft'
    if (!deps.capabilities.includes(capability)) throw new DomainError('FORBIDDEN', '没有该权益包操作权限', 403)
    const revision = required(params, 'expected_revision')
    if (!/^\d+$/u.test(revision) || !Number.isSafeInteger(Number(revision))) throw new DomainError('INVALID_REQUEST', 'expected_revision 无效', 400)
    const item = await repository.mutate({ action, code: required(params, 'code'), expectedRevision: Number(revision), idempotencyKey: required(params, 'idempotency_key'), ...(typeof params.version_id === 'string' ? { versionId: params.version_id } : {}), ...(typeof params.name === 'string' ? { name: params.name } : {}), ...(params.usage === 'included' || params.usage === 'standalone' ? { usage: params.usage } : {}), ...(params.payload_json ? { payload: deps.object(params, 'payload_json') } : {}), ...(params.benefits_json ? { benefits: deps.array(params, 'benefits_json') as CommercialCatalogBenefit[] } : {}), actorId: deps.actorId, reason: required(params, 'reason'), evidence: deps.object(params, 'evidence_json') })
    return { schema_version: 'commercial.benefit-bundle.v1', item }
  } catch (error) {
    if (error instanceof CommercialOpsReadModelError) throw new DomainError(error.code,error.message,400)
    if (error instanceof CommercialCatalogConflictError || error instanceof CommercialCatalogUnavailableError) throw new DomainError(error.code, error.message, 409, { retryable: false, next_actions: ['ops.commercial.benefit-bundles.list'] })
    throw error
  }
}
