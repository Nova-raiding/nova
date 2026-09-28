import { describe, expect, it } from 'vitest'
import { getMcpMethodPolicy } from '../../../packages/contracts/src/index.js'

describe('unbound content candidate authorization', () => {
  it('uses workspace scope for an unbound draft and retains brand scope for formal generation', () => {
    expect(getMcpMethodPolicy('content.draft.generate')).toMatchObject({
      capability: 'customer.content.update',
      scope: 'workspace',
    })
    expect(getMcpMethodPolicy('content.generate')).toMatchObject({
      capability: 'customer.content.update',
      scope: 'brand',
    })
  })
})
