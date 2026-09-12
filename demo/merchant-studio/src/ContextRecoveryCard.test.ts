import { describe, expect, it } from 'vitest'
import { recoveryCopy } from './ContextRecoveryCard'

describe('context recovery copy', () => {
  it('sends identity failures back to product scope', () => {
    expect(recoveryCopy('店铺身份校验失败').primary).toBe('返回知识库范围')
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

  it('explains authorization failures without falling back to demo data', () => {
    expect(recoveryCopy('FORBIDDEN: 当前身份授权决策拒绝 customer.content.read')).toMatchObject({
      title: '当前会话无权读取这项任务',
      primary: '返回知识库范围',
    })
  })

  it('keeps unknown failures recoverable by reload', () => {
    expect(recoveryCopy('网络暂时不可用')).toMatchObject({
      title: '这项任务暂时无法继续',
      primary: '重新加载任务',
    })
  })
})
