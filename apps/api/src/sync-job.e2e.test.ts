import { afterEach, beforeAll, describe, expect, it } from 'vitest'

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
    server = (await import('./server.js')).server
  })
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('retains invalid page items as retryable failures instead of silently dropping them', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_sync_failures' }
    const created = await fetch(`${base}/v1/sync-jobs`, { method: 'POST', headers, body: JSON.stringify({ platform: 'jd', mode: 'full' }) }).then(response => response.json()) as { data: { id: string } }
    const progress = await fetch(`${base}/v1/sync-jobs/${created.data.id}/progress`, { method: 'POST', headers, body: JSON.stringify({ page_number: 1, cursor: 'page-1', next_cursor: 'page-2', items: [{ remote_id: 'ok-1', title: '正常商品', stock: 1 }, { remote_id: 'bad-1', stock: 2 }] }) }).then(response => response.json()) as { data: { itemsUpserted: number; itemsFailed: number; failedItems: Array<{ code: string; retryable: boolean }> } }
    expect(progress.data.itemsUpserted).toBe(1)
    expect(progress.data.itemsFailed).toBe(1)
    expect(progress.data.failedItems).toEqual([expect.objectContaining({ code: 'PRODUCT_REQUIRED_FIELD_MISSING', retryable: true })])
    const retried = await fetch(`${base}/v1/sync-jobs/${created.data.id}/retry-failed`, { method: 'POST', headers, body: JSON.stringify({}) }).then(response => response.json()) as { data: { jobs: Array<{ resumeCursor?: string }> } }
    expect(retried.data.jobs).toEqual([expect.objectContaining({ resumeCursor: 'page-1' })])
  })
})
