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

describe('task answers API', () => {
  beforeAll(async () => { server = (await import('./server.js')).server })
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('persists answers supplied during task creation', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_task_answers' }
    const imported = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: '回答测试商品', local_product_key: 'answer-test', category: '服装', price: 99, stock: 5 }) }).then(response => response.json()) as { data: { id: string } }
    const created = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: imported.data.id, platform: 'taobao', answers: { confirm_facts: true, goal: '春季上新' } }) }).then(response => response.json()) as { data: { id: string; version: number; answers: Record<string, unknown>; missingQuestions: unknown[]; state: string } }
    expect(created.data).toMatchObject({
      answers: { confirm_facts: true, goal: '春季上新' },
      missingQuestions: expect.arrayContaining([
        expect.objectContaining({ id: 'placement', kind: 'recommended' }),
        expect.objectContaining({ id: 'asset_ids', kind: 'optional' }),
      ]),
      state: 'ready_for_direction',
    })
    const deferred = await fetch(`${base}/v1/tasks/${created.data.id}/answers`, { method: 'POST', headers, body: JSON.stringify({ answers: { defer_questions: ['audience'] }, expected_version: created.data.version }) }).then(response => response.json()) as { data: { version: number } }
    expect(deferred.data.version).toBe(created.data.version + 1)
    const resumed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'task.resume', params: { task_id: created.data.id } }) }).then(response => response.json()) as { data?: { result?: { pendingQuestions?: Array<{ id: string; status: string; prompt: string }> } } }
    expect(resumed.data?.result?.pendingQuestions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'audience', status: 'deferred', prompt: expect.any(String) })]))
  })
})
