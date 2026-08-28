import { afterEach, describe, expect, it } from 'vitest'
import { server, service } from './server.js'

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null }

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

describe('content review decision API', () => {
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('persists an auditable P2 waiver through REST and rejects a P0 bypass through MCP', async () => {
    const workspaceId = `ws_review_decision_${Date.now()}`
    const product = service.importProduct({
      workspaceId,
      platform: 'taobao',
      localProductKey: 'review-decision-product',
      title: '审核决策测试商品',
      stock: 10,
      images: ['https://example.com/product.jpg', 'https://example.com/product.jpg'],
    })
    service.confirmProductFacts(workspaceId, product.id)
    const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'merchant-e2e' }

    const before = await fetch(`${base}/v1/content-versions/${version.id}/review`, { headers }).then(response => response.json()) as Envelope<{ findings: Array<{ code: string; field: string; status: string }> }>
    const duplicate = before.data?.findings.find(finding => finding.code === 'DUPLICATE_IMAGE')
    expect(duplicate).toMatchObject({ code: 'DUPLICATE_IMAGE', status: 'open' })

    const waived = await fetch(`${base}/v1/content-versions/${version.id}/review-decisions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: duplicate!.code, field: duplicate!.field, status: 'waived', reason: '候选图用于内部对比，正式发布前删除', expected_revision: version.revision }),
    }).then(response => response.json()) as Envelope<{ version: { revision: number; reviewDecisions: Array<{ status: string; reason: string; actorId: string }> }; report: { findings: Array<{ code: string; status: string }> } }>
    expect(waived.error).toBeNull()
    expect(waived.data?.version.reviewDecisions).toContainEqual(expect.objectContaining({ status: 'waived', reason: '候选图用于内部对比，正式发布前删除', actorId: 'merchant-e2e' }))
    expect(waived.data?.report.findings).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_IMAGE', status: 'waived' }))

    service.products.get(product.id)!.images = []
    const blocked = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'content.review.decide', params: { content_version_id: version.id, code: 'MAIN_IMAGE_REQUIRED', field: 'images[0]', status: 'acknowledged', reason: '尝试绕过阻断项' } }),
    }).then(response => response.json()) as Envelope<unknown>
    expect(blocked.error).toMatchObject({ code: 'REVIEW_P0_DECISION_FORBIDDEN' })
  })
})
