import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateExpectedTaskRequestScopes } from './task-request-scopes.js'
import type { MerchantService } from '../../../packages/application/src/service.js'
import { extractMerchantIntent } from '../../../packages/application/src/merchant-intent-extractor.js'

type Understanding = ReturnType<MerchantService['understandTaskRequest']>
const understanding = (childTasks: Understanding['executionPlan']['childTasks'], splitBySku = childTasks.some(child => child.skuIds?.length)): Understanding => ({
  requestText: '跨平台或 SKU 任务',
  platformCandidates: [...new Set(childTasks.map(child => child.platform))],
  productCandidates: [],
  extracted: {},
  merchantIntent: extractMerchantIntent('跨平台或 SKU 任务'),
  questions: [],
  executionPlan: { mode: splitBySku ? 'split_by_sku' : 'split_by_platform', canCreate: true, reason: '', splitBySku, childTasks },
})

describe('natural-language task request expected scopes', () => {
  it('rejects a changed product or SKU scope before the route can create tasks', () => {
    const plan = understanding([
      { platform: 'jd', candidateProductIds: ['product-jd'], bindingState: 'ready' },
      { platform: 'taobao', candidateProductIds: ['product-taobao'], bindingState: 'ready' },
    ])
    expect(() => validateExpectedTaskRequestScopes([
      { platform: 'jd', product_id: 'product-jd' },
      { platform: 'taobao', product_id: 'different-product' },
    ], plan)).toThrowError(expect.objectContaining({ code: 'TASK_REQUEST_SCOPE_CHANGED', status: 409 }))
    expect(() => validateExpectedTaskRequestScopes([
      { platform: 'jd', product_id: 'product-jd', sku_ids: ['sku-a'] },
      { platform: 'taobao', product_id: 'product-taobao' },
    ], plan)).toThrowError(expect.objectContaining({ code: 'TASK_REQUEST_SCOPE_CHANGED', status: 409 }))
  })

  it('accepts exact platform and SKU scopes regardless of client ordering', () => {
    const plan = understanding([
      { platform: 'jd', candidateProductIds: ['product-jd'], bindingState: 'ready' },
      { platform: 'taobao', candidateProductIds: ['product-taobao'], bindingState: 'ready', skuIds: ['sku-b', 'sku-a'] },
    ])
    expect(() => validateExpectedTaskRequestScopes([
      { platform: 'taobao', product_id: 'product-taobao', sku_ids: ['sku-a', 'sku-b'] },
      { platform: 'jd', product_id: 'product-jd' },
    ], plan)).not.toThrow()
  })

  it('does not confuse available product SKUs with an explicit SKU split', () => {
    const plan = understanding([
      { platform: 'taobao', candidateProductIds: ['product-taobao'], bindingState: 'ready', skuIds: ['sku-a', 'sku-b'] },
    ], false)
    expect(() => validateExpectedTaskRequestScopes([
      { platform: 'taobao', product_id: 'product-taobao' },
    ], plan)).not.toThrow()
  })

  it('validates the client confirmation before any createTaskFromRequest call', () => {
    const source = readFileSync(new URL('./http-task-routes.ts', import.meta.url), 'utf8')
    const route = source.slice(source.indexOf("path === '/v1/task-requests'"), source.indexOf('const skuSplitMatch'))
    expect(route.indexOf('validateExpectedTaskRequestScopes(input.expected_scopes, understanding)')).toBeGreaterThanOrEqual(0)
    expect(route.indexOf('validateExpectedTaskRequestScopes(input.expected_scopes, understanding)')).toBeLessThan(route.indexOf('service.createTaskFromRequest('))
    expect(route).toContain('...(expectedScopes ? { expectedScopes } : {})')
  })

  it('validates MCP expected_scopes before task side effects and forwards the same normalized scope', () => {
    const source = readFileSync(new URL('./mcp-task-write-handlers.ts', import.meta.url), 'utf8')
    const route = source.slice(source.indexOf("case 'task.request.create'"), source.indexOf("case 'task.sku.split'"))
    expect(route).toContain('validateExpectedTaskRequestScopes(expectedScopeInput, understanding)')
    expect(route.indexOf('validateExpectedTaskRequestScopes(expectedScopeInput, understanding)')).toBeLessThan(route.indexOf('service.createTaskFromRequest('))
    expect(route).toContain('...(expectedScopes ? { expectedScopes } : {})')
    expect(route).toContain("typeof expectedScopeInput === 'string'")
  })
})
