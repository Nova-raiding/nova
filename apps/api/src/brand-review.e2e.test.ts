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

describe('brand-bound content review', () => {
  beforeAll(async () => { server = (await import('./server.js')).server })
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('auto-binds the workspace brand revision and returns a blocking brand finding over REST/MCP', async () => {
    const base = await start()
    const workspaceId = `ws_brand_review_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const brand = await fetch(`${base}/v1/brand-profile`, { method: 'PUT', headers, body: JSON.stringify({ name: '云朵', forbidden_terms: ['顶级'] }) }).then(response => response.json()) as { data: { id: string; revision: number } }
    const product = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: '品牌审核商品', local_product_key: 'brand-review', price: 199, stock: 8 }) }).then(response => response.json()) as { data: { id: string } }
    await fetch(`${base}/v1/products/${product.data.id}/confirm`, { method: 'POST', headers, body: '{}' })
    const task = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: product.data.id, platform: 'taobao' }) }).then(response => response.json()) as { data: { id: string; answers: { brand_id?: string } } }
    expect(task.data.answers.brand_id).toBe(brand.data.id)
    await fetch(`${base}/v1/tasks/${task.data.id}/directions`, { method: 'POST', headers, body: JSON.stringify({ direction_id: 'A' }) })
    await fetch(`${base}/v1/tasks/${task.data.id}/plan/confirm`, { method: 'POST', headers, body: '{}' })
    const committed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'content.codex.commit', params: { task_id: task.data.id, body_json: JSON.stringify({ title: '云朵顶级外套', detail: '根据已确认商品事实生成。', sellingPoints: ['事实可追溯'] }) } }) }).then(response => response.json()) as { data: { result: { id: string } } }

    const reviewed = await fetch(`${base}/v1/content-versions/${committed.data.result.id}/review`, { headers }).then(response => response.json()) as { data: { blocking: boolean; findings: Array<{ code: string; priority: string; evidence: { kind: string; sourceIds: string[] } }>; categories: Array<{ id: string; status: string }> } }
    expect(reviewed.data.blocking).toBe(true)
    expect(reviewed.data.findings).toContainEqual(expect.objectContaining({ code: 'BRAND_FORBIDDEN_TERM', priority: 'P0', evidence: expect.objectContaining({ kind: 'brand', sourceIds: [`brand:${brand.data.id}:r${brand.data.revision}`] }) }))
    expect(reviewed.data.categories).toContainEqual(expect.objectContaining({ id: 'brand_consistency', status: 'blocking' }))

    const bypass = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'content.review.decide', params: { content_version_id: committed.data.result.id, code: 'BRAND_FORBIDDEN_TERM', field: 'content', status: 'acknowledged' } }) }).then(response => response.json()) as { error: { code: string } }
    expect(bypass.error.code).toBe('REVIEW_P0_DECISION_FORBIDDEN')
  })
})
