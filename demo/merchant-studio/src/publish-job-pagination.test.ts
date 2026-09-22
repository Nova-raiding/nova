import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fetchPublishJobPage, MERCHANT_PUBLISH_PAGE_SIZE } from './api'

const envelope = (data: unknown) => new Response(JSON.stringify({
  request_id: 'publish-page-test', trace_id: 'publish-page-test', workspace_id: 'ws_demo',
  data, warnings: [], next_actions: [], error: null,
}), { status: 200, headers: { 'content-type': 'application/json' } })

describe('merchant publish job pagination', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_TOKEN', 'merchant-api-test-token')
    vi.stubGlobal('window', globalThis)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('requests exactly the selected server page instead of eagerly reading the whole history', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope({ items: [], total: 47, limit: 20, offset: 20 }))
    vi.stubGlobal('fetch', fetcher)

    await expect(fetchPublishJobPage('http://127.0.0.1:9', { limit: 20, offset: 20 })).resolves.toEqual({
      items: [], total: 47, limit: 20, offset: 20,
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/v1/publish-jobs?limit=20&offset=20')
  })

  it('keeps the desktop page wired to the bounded server contract', () => {
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(MERCHANT_PUBLISH_PAGE_SIZE).toBe(20)
    expect(app).toContain('fetchPublishJobPage(baseUrl')
    expect(app).toContain('aria-label="发布任务分页"')
    expect(app).not.toContain('fetchPublishJobs(baseUrl)')
  })
})
