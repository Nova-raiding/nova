import { describe, expect, it } from 'vitest'
import { createCampaignRuntime } from './campaign-runtime.js'
import type { CampaignBatchRow, CampaignItemRow } from '../../../packages/persistence/src/brand-unit-repository.js'

const baseItem = (overrides: Partial<CampaignItemRow> = {}): CampaignItemRow => ({
  id: 'item_1', workspaceId: 'ws_1', campaignId: 'campaign_1', brandId: 'brand_1', productId: 'product_1',
  platform: 'taobao', accountId: 'account_1', state: 'pending', ordinal: 1, ...overrides,
})

const campaign = (item: CampaignItemRow, state: CampaignBatchRow['state'] = 'draft'): CampaignBatchRow => ({
  id: 'campaign_1', workspaceId: 'ws_1', brandId: 'brand_1', platform: 'taobao', accountId: 'account_1',
  productIds: ['product_1'], state, revision: 1, createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z', items: [item],
})

function runtime(task?: Record<string, unknown>, publishJobs: Array<Record<string, unknown>> = []) {
  const updates: unknown[] = []
  const result = createCampaignRuntime({
    service: {
      tasks: new Map(task ? [[String(task.id), task]] : []),
      listPublishJobs: () => publishJobs,
    } as never,
    repository: () => ({
      updateCampaignProgress: async (input: unknown) => { updates.push(input); return input as never },
    }),
  })
  return { result, updates }
}

describe('campaign task status projection', () => {
  it.each([
    ['draft', 'manual_attention', 'PRODUCT_FACTS_CONFIRMATION_REQUIRED'],
    ['ready_for_direction', 'manual_attention', 'DIRECTION_CONFIRMATION_REQUIRED'],
    ['direction_selected', 'manual_attention', 'PLAN_CONFIRMATION_REQUIRED'],
    ['plan_confirmed', 'generating', 'CONTENT_GENERATION_READY'],
    ['review_required', 'review_required', 'HUMAN_REVIEW_REQUIRED'],
    ['approved', 'review_required', 'PUBLISH_PREPARATION_READY'],
    ['publish_prepared', 'review_required', 'PUBLISH_CONFIRMATION_REQUIRED'],
    ['delivered', 'completed', undefined],
  ] as const)('maps task state %s to campaign state %s without inventing completion', (taskState, expectedState, code) => {
    const { result, updates } = runtime({ id: 'task_1', workspaceId: 'ws_1', state: taskState })
    const projected = result.refreshCampaignProgress(campaign(baseItem({ taskId: 'task_1' })))
    return projected.then(value => {
      expect(value).toMatchObject({ state: expectedState })
      const itemState = taskState === 'delivered' ? 'published'
        : taskState === 'draft' ? 'blocked'
          : taskState === 'ready_for_direction' || taskState === 'direction_selected' ? 'manual_attention'
            : taskState === 'plan_confirmed' ? 'generating'
              : taskState === 'publish_prepared' ? 'approved' : taskState
      expect(updates[0]).toMatchObject({ state: expectedState, items: [{ state: itemState, ...(code ? { error: { code } } : {}) }] })
    })
  })

  it('fails closed for a missing or cross-workspace task snapshot', async () => {
    const missing = runtime().result
    await expect(missing.refreshCampaignProgress(campaign(baseItem({ taskId: 'missing' })))).resolves.toMatchObject({ state: 'unknown' })

    const crossWorkspace = runtime({ id: 'task_1', workspaceId: 'ws_other', state: 'delivered' }).result
    await expect(crossWorkspace.refreshCampaignProgress(campaign(baseItem({ taskId: 'task_1' })))).resolves.toMatchObject({ state: 'unknown' })
  })

  it.each([
    ['published', 'completed'],
    ['rejected', 'failed'],
    ['manual_attention', 'manual_attention'],
    ['unknown', 'unknown'],
    ['queued', 'publishing'],
  ] as const)('projects the latest publish job state %s while publishing', async (publishState, expectedState) => {
    const { result } = runtime(
      { id: 'task_1', workspaceId: 'ws_1', state: 'publishing' },
      [{ taskId: 'task_1', state: publishState, createdAt: '2026-10-06T00:00:00.000Z', ...(publishState === 'rejected' ? { rejection: { rawCode: 'REMOTE_REJECTED', message: 'rejected' } } : {}) }],
    )
    await expect(result.refreshCampaignProgress(campaign(baseItem({ taskId: 'task_1' })))).resolves.toMatchObject({ state: expectedState })
  })

  it('does not write a duplicate progress update when the durable projection is unchanged', async () => {
    const { result, updates } = runtime({ id: 'task_1', workspaceId: 'ws_1', state: 'review_required' })
    const unchanged = campaign(baseItem({ taskId: 'task_1', state: 'review_required', error: { code: 'HUMAN_REVIEW_REQUIRED', message: '内容已生成，等待规则审核和人工批准', nextAction: 'content.review' } }), 'review_required')
    await expect(result.refreshCampaignProgress(unchanged)).resolves.toBe(unchanged)
    expect(updates).toHaveLength(0)
  })
})
