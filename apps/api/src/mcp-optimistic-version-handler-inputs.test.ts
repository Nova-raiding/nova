import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { MerchantService } from '../../../packages/application/src/service.js'
import { handleMcpContentReview, type McpContentReviewDependencies } from './mcp-content-review-handlers.js'
import { handleMcpCreative, type McpCreativeDependencies } from './mcp-creative-handlers.js'

const invalidVersions: unknown[] = ['not-a-version', '', true, 1, '1.5', '1e2', '0', '9007199254740992']
const req = {} as IncomingMessage

describe('MCP optimistic version handler inputs', () => {
  it.each(invalidVersions)('rejects malformed creative direction expected_version %j before side effects', async expected_version => {
    const update = vi.fn()
    const persistSnapshot = vi.fn()
    const persistEvent = vi.fn()
    const deps = {
      service: { updateCreativeDirections: update },
      scopeTask: vi.fn(),
      persistSnapshot,
      persistEvent,
    } as unknown as McpCreativeDependencies

    await expect(handleMcpCreative('creative.directions.update', { expected_version }, req, 'ws-test', deps))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(update).not.toHaveBeenCalled()
    expect(persistSnapshot).not.toHaveBeenCalled()
    expect(persistEvent).not.toHaveBeenCalled()
  })

  it.each(invalidVersions)('rejects malformed review expected_revision %j before side effects', async expected_revision => {
    const decide = vi.fn()
    const persistSnapshot = vi.fn()
    const persistEvent = vi.fn()
    const deps = {
      service: { setReviewFindingDecision: decide },
      scopeContentVersion: vi.fn(),
      assertReviewDecisionPreflight: vi.fn(),
      persistSnapshot,
      persistEvent,
    } as unknown as McpContentReviewDependencies

    await expect(handleMcpContentReview('content.review.decide', { expected_revision }, req, 'ws-test', deps))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(decide).not.toHaveBeenCalled()
    expect(persistSnapshot).not.toHaveBeenCalled()
    expect(persistEvent).not.toHaveBeenCalled()
  })
})
