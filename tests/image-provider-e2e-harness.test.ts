import { describe, expect, it } from 'vitest'
import { freshImageE2eIdempotencyKey, runImageProviderE2e } from '../scripts/image-provider-e2e-harness.js'

function response(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) }

describe('image provider E2E harness', () => {
  it('creates one candidate and polls only the returned job without review, approval, or publish', async () => {
    const requests: any[] = []
    let polls = 0
    const report = await runImageProviderE2e({
      baseUrl: 'https://example.test', accessToken: 'secret', workspaceId: 'ws_1', productId: 'prod_1',
      pollMs: 0, timeoutMs: 1_000,
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(String(init?.body)); requests.push(request)
        if (request.method === 'catalog.image.generate') return response({ result: { job_id: 'job_exact', state: 'queued' } })
        polls += 1
        return response({ result: { job_id: 'job_exact', state: polls === 1 ? 'running' : 'succeeded', archive_state: 'archived', outputs: [{ asset_id: 'asset_1' }] } })
      },
      evidenceReader: async binding => ({ provider_request_id: 'provider_1', usage: { image_count: 1 }, cost_cny: '0.12', reservation: 'settled', archive: 'archived', scan: 'clean', binding }),
    })
    expect(requests[0].params).toMatchObject({ product_id: 'prod_1', count: '1' })
    expect(requests[0].params.idempotency_key).toMatch(/^image-provider-e2e:\d{17}:[a-f0-9]{24}$/u)
    expect(report.binding.idempotency_key).toBe(requests[0].params.idempotency_key)
    expect(requests.slice(1).every(request => request.method === 'catalog.image.get' && request.params.job_id === 'job_exact')).toBe(true)
    expect(requests.map(request => request.method)).not.toEqual(expect.arrayContaining(['catalog.image.review', 'catalog.image.select', 'content.publish']))
    expect(report.safety).toEqual({ generated_count: 1, selected: false, reviewed: false, approved: false, published: false })
    expect(report.durable_evidence.provider_request_id).toBe('provider_1')
    expect(JSON.stringify(report)).not.toContain('secret')
  })

  it('fails closed if a poll returns a different job', async () => {
    let call = 0
    await expect(runImageProviderE2e({
      baseUrl: 'https://example.test', accessToken: 'secret', workspaceId: 'ws_1', productId: 'prod_1', pollMs: 0, timeoutMs: 100,
      fetchImpl: async () => response({ result: call++ === 0 ? { job_id: 'job_expected', state: 'queued' } : { job_id: 'job_other', state: 'succeeded' } }),
    })).rejects.toThrow('poll_job_identity_mismatch:job_other')
  })

  it('produces fresh namespaced idempotency keys', () => {
    expect(freshImageE2eIdempotencyKey(new Date('2026-09-29T12:00:00.000Z'), 'abc')).toBe('image-provider-e2e:20260929120000000:abc')
    expect(freshImageE2eIdempotencyKey()).not.toBe(freshImageE2eIdempotencyKey())
  })
})
