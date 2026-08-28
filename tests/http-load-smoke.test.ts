import { describe, expect, it } from 'vitest'
import { runHttpConcurrencySmoke } from './http-load-smoke.js'

describe('real HTTP pilot capacity smoke', () => {
  it('runs 50 isolated workspaces through one temporary HTTP server and deduplicates writes', async () => {
    const summary = await runHttpConcurrencySmoke(50)
    expect(summary).toMatchObject({
      profile: 'pilot_50_http_fake',
      transport: 'real_http',
      connectorMode: 'fake',
      cloudGate: false,
      workspaces: 50,
      duplicatePublishRequests: 100,
      acceptedPublishJobs: 100,
      uniquePublishJobs: 50,
      duplicateWrites: 50,
    })
    expect(summary.requests).toBe(400)
    expect(summary.errors).toEqual([])
  }, 30_000)
})
