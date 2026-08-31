import { describe, expect, it } from 'vitest'
import { batchCompletionMessage, resolveBatchReadiness } from './src/batch-readiness.js'

describe('batch entry readiness', () => {
  it('does not promise a real action while offline', () => {
    expect(resolveBatchReadiness(false, 4)).toMatchObject({ canCreateGroup: false, nextStep: '配置 API 后才能创建真实任务组' })
  })

  it('requires two scoped targets before creating a group', () => {
    expect(resolveBatchReadiness(true, 1)).toMatchObject({ canCreateGroup: false, nextStep: '至少选择 2 个商品 + 平台 + 店铺目标' })
  })

  it('makes clear that group creation is not generation or publishing', () => {
    expect(resolveBatchReadiness(true, 2)).toMatchObject({ canCreateGroup: true, nextStep: '创建任务组后，逐个子任务完成生成、审核和发布确认' })
  })

  it('keeps the created group reachable through the task queue', () => {
    expect(batchCompletionMessage('group-1', 3)).toContain('营销任务中逐个完成')
  })
})
