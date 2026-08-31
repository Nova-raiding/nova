import { describe, expect, it } from 'vitest'
import { recoveryCopy } from './ContextRecoveryCard'

describe('context recovery copy', () => {
  it('sends identity failures back to product scope', () => {
    expect(recoveryCopy('店铺身份校验失败').primary).toBe('返回商品与素材范围')
  })

  it('sends uncertain generation back to the task list', () => {
    expect(recoveryCopy('内容生成处理中，暂未确认').primary).toBe('查看任务列表')
  })

  it('explains model relay blockers without blaming the merchant context', () => {
    expect(recoveryCopy('MODEL_RELAY_EVIDENCE_REQUIRED')).toMatchObject({
      title: '模型服务尚未就绪',
      primary: '重新加载任务',
    })
  })

  it('keeps unknown failures recoverable by reload', () => {
    expect(recoveryCopy('网络暂时不可用')).toMatchObject({
      title: '这项任务暂时无法继续',
      primary: '重新加载任务',
    })
  })
})
