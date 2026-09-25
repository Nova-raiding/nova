import { describe, expect, it, vi } from 'vitest'
import { handleCommercialOpsFactMethod } from './mcp-commercial-ops-facts.js'

describe('commercial access block facts', () => {
  it('normalizes a cursor-less legacy array as an untruncated first page', async () => {
    const listAccessDecisions = vi.fn().mockResolvedValue([])
    const result = await handleCommercialOpsFactMethod('ops.commercial.access-blocks.list', { target_workspace_id: 'ws_test' }, {
      persistence: { commercialContracts: { listAccessDecisions } } as never,
      commercialAccessService: { decide: vi.fn() },
      required: (_params, key) => key === 'target_workspace_id' ? 'ws_test' : '',
      commercialOpsReadInput: project => project(),
    })

    expect(listAccessDecisions).toHaveBeenCalledWith('ws_test', expect.objectContaining({ cursor: undefined }))
    expect(result).toMatchObject({ schema_version: 'commercial.access-blocks.v2', items: [], total: 0, next_cursor: null, truncated: false })
  })
})
