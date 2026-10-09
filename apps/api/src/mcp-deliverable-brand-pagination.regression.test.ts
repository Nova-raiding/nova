import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { MerchantService } from '../../../packages/application/src/service.js'
import { handleMcpTaskReadFeedback, type McpTaskReadFeedbackDependencies } from './mcp-task-read-feedback-handlers.js'

describe('deliverable.list brand scoped pagination', () => {
  it('filters before paging and totalMatched, and binds continuation cursors to authorized brands', async () => {
    const service = new MerchantService()
    const visibleIds = ['brand_allowed_a', 'brand_allowed_b']
    const restrictedIds = ['brand_hidden_a', 'brand_hidden_b', 'brand_hidden_c']
    for (const [index, brandId] of [...visibleIds, ...restrictedIds].entries()) {
      const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', requestText: `brand pagination ${index}` })
      task.brandId = brandId
      const versionId = `cv_brand_page_${index}`
      service.contentVersions.set(versionId, {
        id: versionId,
        taskId: task.id,
        version: 1,
        body: { title: `brand-result-${brandId}`, detail: 'private body', sellingPoints: [] },
        factVersionIds: [],
        ruleVersionIds: [],
        state: 'approved',
        revision: 1,
      })
    }
    const deps = {
      service,
      accessibleTaskBrandIds: async () => visibleIds,
    } as unknown as McpTaskReadFeedbackDependencies
    const request = {} as IncomingMessage
    const first = await handleMcpTaskReadFeedback('deliverable.list', { query: 'brand-result-', limit: '1' }, request, 'ws_demo', deps) as {
      items: Array<{ title: string }>; totalMatched: number; hasMore: boolean; nextCursor: string | null
    }
    expect(first).toMatchObject({ totalMatched: 2, hasMore: true })
    expect(first.items).toHaveLength(1)
    expect(first.items[0]!.title).toContain('brand_allowed_')

    const second = await handleMcpTaskReadFeedback('deliverable.list', { query: 'brand-result-', limit: '1', cursor: first.nextCursor! }, request, 'ws_demo', deps) as typeof first
    expect(second).toMatchObject({ totalMatched: 2, hasMore: false, nextCursor: null })
    expect(second.items).toHaveLength(1)
    expect(new Set([first.items[0]!.title, second.items[0]!.title])).toEqual(new Set([
      'brand-result-brand_allowed_a',
      'brand-result-brand_allowed_b',
    ]))
    expect([...first.items, ...second.items].some(item => restrictedIds.some(id => item.title.includes(id)))).toBe(false)

    await expect(handleMcpTaskReadFeedback('deliverable.list', { query: 'brand-result-', limit: '1', cursor: first.nextCursor! }, request, 'ws_demo', {
      ...deps,
      accessibleTaskBrandIds: async () => ['brand_allowed_a'],
    } as unknown as McpTaskReadFeedbackDependencies)).rejects.toMatchObject({ code: 'DELIVERABLE_CURSOR_INVALID' })
  })
})
