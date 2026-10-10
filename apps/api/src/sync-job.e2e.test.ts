import { afterEach, beforeAll, describe, expect, it } from 'vitest'

let api: typeof import('./server.js')
let server: typeof import('./server.js').server

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('durable sync failure projection', () => {
  beforeAll(async () => {
    process.env.CONNECTOR_FIXTURE_MODE = 'true'
    api = await import('./server.js')
    server = api.server
  })
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('retains invalid page items as retryable failures instead of silently dropping them', async () => {
    const base = await start()
    await api.grantCreativePointsForTests('ws_sync_failures')
    api.grantContinuousFeatureEntitlementForTests('ws_sync_failures')
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_sync_failures' }
    const created = await fetch(`${base}/v1/sync-jobs`, { method: 'POST', headers, body: JSON.stringify({ platform: 'jd', mode: 'full' }) }).then(response => response.json()) as { data: { id: string } }
    const progress = await fetch(`${base}/v1/sync-jobs/${created.data.id}/progress`, { method: 'POST', headers, body: JSON.stringify({ page_number: 1, cursor: 'page-1', next_cursor: 'page-2', items: [{ remote_id: 'ok-1', title: '正常商品', stock: 1 }, { remote_id: 'bad-1', stock: 2 }] }) }).then(response => response.json()) as { data: { itemsUpserted: number; itemsFailed: number; failedItems: Array<{ code: string; retryable: boolean }> } }
    expect(progress.data.itemsUpserted).toBe(1)
    expect(progress.data.itemsFailed).toBe(1)
    expect(progress.data.failedItems).toEqual([expect.objectContaining({ code: 'PRODUCT_REQUIRED_FIELD_MISSING', retryable: true })])
    const retried = await fetch(`${base}/v1/sync-jobs/${created.data.id}/retry-failed`, { method: 'POST', headers, body: JSON.stringify({}) }).then(response => response.json()) as { data: { jobs: Array<{ resumeCursor?: string }> } }
    expect(retried.data.jobs).toEqual([expect.objectContaining({ resumeCursor: 'page-1' })])
  })

  it('rejects non-object page items with an indexed input error before advancing the job', async () => {
    const base = await start()
    await api.grantCreativePointsForTests('ws_sync_invalid_shape')
    api.grantContinuousFeatureEntitlementForTests('ws_sync_invalid_shape')
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_sync_invalid_shape' }
    const created = await fetch(`${base}/v1/sync-jobs`, { method: 'POST', headers, body: JSON.stringify({ platform: 'jd', mode: 'full' }) }).then(response => response.json()) as { data: { id: string } }

    const rejected = await fetch(`${base}/v1/sync-jobs/${created.data.id}/progress`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ page_number: 1, items: [{ remote_id: 'ok-1', title: '正常商品' }, null] }),
    })
    const error = await rejected.json() as { error: { code: string; message: string; details?: { field?: string } } }
    expect(rejected.status).toBe(400)
    expect(error.error).toMatchObject({ code: 'INVALID_REQUEST', message: 'items[1] 必须是对象', details: { field: 'items[1]' } })

    const unchanged = await fetch(`${base}/v1/sync-jobs/${created.data.id}`, { headers }).then(response => response.json()) as { data: { pages: number; itemsUpserted: number } }
    expect(unchanged.data).toMatchObject({ pages: 0, itemsUpserted: 0 })
  })

  it.each([
    ['boolean', true], ['fractional number', 1.5], ['exponent string', '1e2'],
    ['hex-like string', '0x10'], ['unsafe integer', 9007199254740992],
  ])('rejects malformed page_number (%s) before advancing the job', async (_label, page_number) => {
    const base = await start()
    const workspaceId = `ws_sync_invalid_page_${String(page_number).replace(/\W/gu, '_')}`
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const created = await fetch(`${base}/v1/sync-jobs`, { method: 'POST', headers, body: JSON.stringify({ platform: 'jd', mode: 'full' }) }).then(response => response.json()) as { data: { id: string } }

    const rejected = await fetch(`${base}/v1/sync-jobs/${created.data.id}/progress`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ page_number, items: [{ remote_id: 'must-not-upsert', title: '不应写入' }] }),
    })
    const error = await rejected.json() as { error: { code: string; message: string } }
    expect(rejected.status).toBe(400)
    expect(error.error).toMatchObject({ code: 'INVALID_REQUEST', message: 'page_number 无效' })

    const unchanged = await fetch(`${base}/v1/sync-jobs/${created.data.id}`, { headers }).then(response => response.json()) as { data: { pages: number; itemsUpserted: number } }
    expect(unchanged.data).toMatchObject({ pages: 0, itemsUpserted: 0 })
  })
})
