import { describe, expect, it } from 'vitest'
import { materialUploadBalanceNotice } from './App'
import type { BillingStatus } from './api'

const billingWithPoints = (available_points: number | null) => ({ available_points }) as BillingStatus

describe('素材上传前的创意点提示', () => {
  it('余额读取失败或未知时提示核对权益，不声称上传已成功', () => {
    expect(materialUploadBalanceNotice(null)).toContain('余额尚未确认')
    expect(materialUploadBalanceNotice(billingWithPoints(null))).toContain('当前上传可能被服务端拒绝')
  })

  it('余额为零时提前提示到账门禁', () => {
    expect(materialUploadBalanceNotice(billingWithPoints(0))).toContain('余额为 0')
    expect(materialUploadBalanceNotice(billingWithPoints(0))).toContain('服务端实时校验')
  })

  it('余额为正时不虚构额外上传阻断', () => {
    expect(materialUploadBalanceNotice(billingWithPoints(5000))).toBeNull()
  })
})
