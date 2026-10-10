import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { isSellingPointProofRequiredError, productFactConfirmationBlockers } from './product-fact-confirmation.js'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('product fact confirmation recovery', () => {
  it('blocks confirmation only for claims missing a confirmed status or source', () => {
    expect(productFactConfirmationBlockers([
      { id: 'sp-ready', text: '可验证卖点', proofStatus: 'confirmed', sourceIds: ['asset-1'] },
      { id: 'sp-no-source', text: '没有来源', proofStatus: 'confirmed', sourceIds: [] },
      { id: 'sp-pending', text: '待核实', proofStatus: 'pending', sourceIds: ['asset-2'] },
    ]).map((point) => point.id)).toEqual(['sp-no-source', 'sp-pending'])
    expect(productFactConfirmationBlockers(undefined)).toEqual([])
  })

  it('recognizes the server proof-required response for targeted recovery copy', () => {
    expect(isSellingPointProofRequiredError({ code: 'SELLING_POINT_PROOF_REQUIRED' })).toBe(true)
    expect(isSellingPointProofRequiredError(new Error('核心卖点必须有来源并完成证明确认后，才能确认商品事实'))).toBe(true)
    expect(isSellingPointProofRequiredError(new Error('商品版本冲突'))).toBe(false)
    expect(isSellingPointProofRequiredError(null)).toBe(false)
  })

  it('disables known-unproven confirmation and exposes a concrete recovery route', () => {
    expect(app).toContain('disabled={Boolean(operation) || !task || factProofBlockers.length > 0}')
    expect(app).toContain('question.id === \'confirm_facts\' && isSellingPointProofRequiredError(cause)')
    expect(app).toContain('补齐来源素材并将证明状态改为“已确认”')
    expect(app).toContain('onClick={onBackToProducts}>返回商品目录定位商品')
  })
})
