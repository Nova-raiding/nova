import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parsePublishBatchDetail, publishBatchItemKey, publishBatchItemScope, queueStateLabel, visualEvidenceState } from './MarketingQueuePanel.js'

const panelSource = readFileSync(new URL('./MarketingQueuePanel.tsx', import.meta.url), 'utf8')

describe('marketing queue delivery evidence', () => {
  it('gives every asynchronous state a truthful, user-facing label', () => {
    expect(queueStateLabel('queued')).toBe('排队中')
    expect(queueStateLabel('processing')).toBe('处理中')
    expect(queueStateLabel('failed')).toBe('失败')
    expect(queueStateLabel('unknown')).toBe('待对账')
    expect(queueStateLabel('dispatching')).toBe('已提交模型请求，等待受理确认')
    expect(queueStateLabel('provider_started')).toBe('模型已受理，等待结果确认')
    expect(queueStateLabel('future_state')).toBe('状态待确认')
  })

  it('never promotes manual visual review to authenticity verified', () => {
    expect(visualEvidenceState('passed')).toBe('evidence_unverified')
    expect(visualEvidenceState('pending')).toBe('evidence_unverified')
    expect(visualEvidenceState('blocked')).toBe('blocked')
  })

  it('preserves independent platform, account, product and task scope', () => {
    expect(publishBatchItemScope({
      taskId: 'task-1',
      productId: 'product-1',
      platform: 'douyin',
      accountId: 'store-1',
      contentVersionId: 'content-1',
      state: 'failed',
    })).toEqual({
      platform: 'douyin',
      accountId: 'store-1',
      productId: 'product-1',
      taskId: 'task-1',
      state: 'failed',
    })
  })

  it('keeps omitted server scope explicitly unknown', () => {
    expect(publishBatchItemScope({ taskId: 'task-2', state: 'queued' })).toEqual({
      platform: null,
      accountId: null,
      productId: null,
      taskId: 'task-2',
      state: 'queued',
    })
  })

  it('uses a stable composite key for one task delivered to distinct scopes', () => {
    const base = { taskId: 'task-1', productId: 'product-1', contentVersionId: 'content-1', state: 'queued' }
    expect(publishBatchItemKey({ ...base, platform: 'douyin', accountId: 'store-1' })).not.toBe(
      publishBatchItemKey({ ...base, platform: 'jd', accountId: 'store-2' }),
    )
  })

  it('rejects malformed batch responses before rendering', () => {
    expect(() => parsePublishBatchDetail({ id: 'batch-1', state: 'running', items: [{ state: 'queued' }] })).toThrow('缺少 taskId 或 state')
    expect(parsePublishBatchDetail({ id: 'batch-1', state: 'running', items: [{ taskId: 'task-1', state: 'queued', productId: 123 }] }).items[0]?.productId).toBeUndefined()
  })

  it('requires explicit confirmation and a reason before visual review writes', () => {
    expect(panelSource).toContain('确认视觉候选通过')
    expect(panelSource).toContain('确认阻断视觉候选')
    expect(panelSource).toContain('视觉审核原因')
    expect(panelSource).toContain('visualReviewReason.trim().length < 4')
    expect(panelSource).toContain('visualReviewTarget.visual.revision')
  })

  it('renders durable asset scan failure fields and never treats missing evidence as retryable', () => {
    expect(panelSource).toContain('扫描死信 event_id')
    expect(panelSource).toContain('retryable ${recovery.retryable === true ? "true"')
    expect(panelSource).toContain('revision ${recovery.assetRevision ?? "未返回"}')
    expect(panelSource).toContain('扫描死信证据未返回，保持禁止人工重试')
    expect(panelSource).not.toContain('扫描重试后自动标记 clean')
  })

  it('does not offer manual close for observation states and exposes reconciliation only for unknown outcomes', () => {
    expect(panelSource).toContain('仅观测，不可重复生成')
    expect(panelSource).toContain('打开对账')
    expect(panelSource).toContain('禁止重复生成')
    expect(panelSource).toContain('不会创建第二个 Provider 请求')
  })
})
