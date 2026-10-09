import { DomainError, type MerchantService, type Platform } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

type TaskUnderstanding = ReturnType<MerchantService['understandTaskRequest']>

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Validate a caller-confirmed request scope against the freshly resolved plan. */
export function validateExpectedTaskRequestScopes(input: unknown, understanding: TaskUnderstanding): Array<{ platform: Platform; productId: string; skuIds?: string[] }> | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_scopes 必须是数组', 400)
  const normalize = (scopes: unknown[]) => scopes.map((value, index) => {
    if (!isObject(value) || typeof value.platform !== 'string' || typeof value.product_id !== 'string' || !value.product_id.trim()) {
      throw new DomainError(ERROR_CODES.INVALID_REQUEST, `expected_scopes[${index}] 必须包含 platform 和 product_id`, 400)
    }
    const skuIds = value.sku_ids === undefined ? [] : Array.isArray(value.sku_ids) && value.sku_ids.every(id => typeof id === 'string' && id.trim()) ? [...new Set(value.sku_ids.map(id => (id as string).trim()))].sort() : null
    if (!skuIds || (Array.isArray(value.sku_ids) && skuIds.length !== value.sku_ids.length)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `expected_scopes[${index}].sku_ids 无效`, 400)
    return { platform: value.platform, productId: value.product_id.trim(), skuIds }
  }).sort((left, right) => `${left.platform}:${left.productId}:${left.skuIds.join(',')}`.localeCompare(`${right.platform}:${right.productId}:${right.skuIds.join(',')}`))
  const actualScopes = understanding.executionPlan.childTasks.map(child => ({
    platform: child.platform,
    product_id: child.candidateProductIds[0] ?? '',
    sku_ids: understanding.executionPlan.splitBySku ? child.skuIds ?? [] : [],
  }))
  const expected = normalize(input)
  const actual = normalize(actualScopes)
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new DomainError('TASK_REQUEST_SCOPE_CHANGED', '商品或 SKU 范围与已确认的执行计划不一致；任务未创建，请重新分析并确认范围', 409, { expected_scopes: expected, actual_scopes: actual })
  }
  return expected.map(scope => ({ platform: scope.platform as Platform, productId: scope.productId, ...(scope.skuIds.length ? { skuIds: scope.skuIds } : {}) }))
}
