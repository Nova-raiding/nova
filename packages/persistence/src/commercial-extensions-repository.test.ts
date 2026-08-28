import { describe, expect, it } from 'vitest'
import { MemoryCommercialExtensionsRepository } from './commercial-extensions-repository.js'

describe('model markup policy', () => {
  it('defaults to 2.5 and protects concurrent updates with a revision', async () => {
    const repository = new MemoryCommercialExtensionsRepository()
    const initial = await repository.getModelMarkupPolicy()
    expect(initial).toMatchObject({ multiplier: 2.5, revision: 1, updatedBy: 'system' })

    const updated = await repository.updateModelMarkupPolicy({ multiplier: 3, reason: '成本策略调整', updatedBy: 'finance_1', expectedRevision: initial.revision })
    expect(updated).toMatchObject({ multiplier: 3, revision: 2, reason: '成本策略调整', updatedBy: 'finance_1' })
    await expect(repository.updateModelMarkupPolicy({ multiplier: 4, reason: '过期修改', updatedBy: 'finance_2', expectedRevision: initial.revision })).rejects.toThrow('revision conflict')
  })
})
