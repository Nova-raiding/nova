import { describe, expect, it } from 'vitest'
import { brandUnitSelectionMessage } from './brand-unit-selection'

describe('brand unit selection guidance', () => {
  it('does not claim the read-only list method performs association', () => {
    expect(brandUnitSelectionMessage(5)).toContain('brand-unit.list 仅用于查看候选')
    expect(brandUnitSelectionMessage(5)).toContain('有权限的运营工作台或插件完成')
    expect(brandUnitSelectionMessage(5)).not.toContain('请先通过 brand-unit.list 选择并关联')
  })

  it('normalizes invalid candidate counts for honest UI copy', () => {
    expect(brandUnitSelectionMessage(-1)).toContain('0 个候选')
    expect(brandUnitSelectionMessage(Number.NaN)).toContain('0 个候选')
  })
})
