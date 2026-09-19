import { afterEach, describe, expect, it } from 'vitest'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, server, service } from './server.js'

type Envelope<T> = { data: T | null; error: { code: string; message: string; details?: Record<string, unknown> } | null }
type ReviewReport = { findings: Array<{ code: string; field: string; status: string; priority?: string }> }

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

function seedReviewableVersion(workspaceId: string) {
  const product = service.importProduct({
    workspaceId, platform: 'taobao', localProductKey: `review-gate-${workspaceId}`,
    title: '商业门禁审核商品', stock: 10,
    images: ['https://example.com/product.jpg', 'https://example.com/product.jpg'],
  })
  service.confirmProductFacts(workspaceId, product.id)
  const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao' })
  service.selectDirection(task.id, 'A')
  const version = service.createDraft(task.id)
  return { product, task, version }
}

async function mcp(base: string, headers: Record<string, string>, id: number, method: string, params: Record<string, unknown>) {
  return fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    .then(async response => ({ status: response.status, body: await response.json() as Envelope<any> }))
}

async function reviewReport(base: string, headers: Record<string, string>, versionId: string) {
  return fetch(`${base}/v1/content-versions/${versionId}/review`, { headers })
    .then(async response => ({ status: response.status, body: await response.json() as Envelope<ReviewReport> }))
}

describe('content.review.decide commercial gate', () => {
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('denies the MCP decision for a workspace whose commercial facts are unknown, and leaves the finding open', async () => {
    const workspaceId = `ws_review_gate_unknown_${Date.now()}`
    const { version } = seedReviewableVersion(workspaceId)
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'review-gate-actor' }

    const before = await reviewReport(base, headers, version.id)
    const finding = before.body.data!.findings.find(item => item.code === 'DUPLICATE_IMAGE')
    expect(finding).toMatchObject({ code: 'DUPLICATE_IMAGE', status: 'open', priority: 'P2' })

    // Zero/unknown creative points: the balance projection reports `unknown`,
    // which must fail closed rather than being projected as zero.
    const balance = await mcp(base, headers, 1, 'creative-points.balance.get', {})
    expect(balance.body.data!.result).toMatchObject({ balance_state: 'unknown', available_points: null })

    const decided = await mcp(base, headers, 2, 'content.review.decide', {
      content_version_id: version.id, code: finding!.code, field: finding!.field, status: 'waived', reason: '试图在无权益状态下修改审核结论',
    })
    expect(decided.body.error).toMatchObject({ code: 'CREATIVE_POINTS_UNAVAILABLE' })
    expect(decided.status).toBe(503)

    const after = await reviewReport(base, headers, version.id)
    expect(after.body.data!.findings.find(item => item.code === 'DUPLICATE_IMAGE')).toMatchObject({ status: 'open' })
  })

  it('denies the MCP decision for a funded workspace that has no continuous entitlement', async () => {
    const workspaceId = `ws_review_gate_unentitled_${Date.now()}`
    // Funded wallet, no continuous entitlement: the exact "零余额/无权益" split
    // the deferred gate used to skip.
    await grantCreativePointsForTests(workspaceId, 100)
    const { version } = seedReviewableVersion(workspaceId)
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'review-gate-actor' }
    const finding = (await reviewReport(base, headers, version.id)).body.data!.findings.find(item => item.code === 'DUPLICATE_IMAGE')!

    const decided = await mcp(base, headers, 1, 'content.review.decide', {
      content_version_id: version.id, code: finding.code, field: finding.field, status: 'waived', reason: '无权益不应接受风险',
    })
    expect(decided.body.error).toMatchObject({ code: 'COMMERCIAL_ENTITLEMENT_REQUIRED' })
    expect(decided.status).toBe(402)

    expect((await reviewReport(base, headers, version.id)).body.data!.findings.find(item => item.code === 'DUPLICATE_IMAGE')).toMatchObject({ status: 'open' })
  })

  it('denies the REST decision for a funded workspace that has no continuous entitlement', async () => {
    const workspaceId = `ws_review_gate_rest_${Date.now()}`
    await grantCreativePointsForTests(workspaceId, 100)
    const { version } = seedReviewableVersion(workspaceId)
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'review-gate-actor' }
    const finding = (await reviewReport(base, headers, version.id)).body.data!.findings.find(item => item.code === 'DUPLICATE_IMAGE')!

    const decided = await fetch(`${base}/v1/content-versions/${version.id}/review-decisions`, {
      method: 'POST', headers,
      body: JSON.stringify({ code: finding.code, field: finding.field, status: 'waived', reason: '无权益不应接受风险', expected_revision: version.revision }),
    }).then(async response => ({ status: response.status, body: await response.json() as Envelope<unknown> }))
    expect(decided.body.error).toMatchObject({ code: 'COMMERCIAL_ENTITLEMENT_REQUIRED' })
    expect(decided.status).toBe(402)

    expect((await reviewReport(base, headers, version.id)).body.data!.findings.find(item => item.code === 'DUPLICATE_IMAGE')).toMatchObject({ status: 'open' })
  })

  it('keeps the P0 waiver contract ahead of the commercial gate', async () => {
    const workspaceId = `ws_review_gate_p0_${Date.now()}`
    const { product, version } = seedReviewableVersion(workspaceId)
    // Removing every image makes the deterministic checker raise the P0
    // MAIN_IMAGE_REQUIRED blocker, which must stay un-waivable even when the
    // workspace has no commercial access at all.
    service.products.get(product.id)!.images = []
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'review-gate-actor' }

    const decided = await mcp(base, headers, 1, 'content.review.decide', {
      content_version_id: version.id, code: 'MAIN_IMAGE_REQUIRED', field: 'images[0]', status: 'acknowledged', reason: '尝试绕过阻断项',
    })
    expect(decided.body.error).toMatchObject({ code: 'REVIEW_P0_DECISION_FORBIDDEN' })
  })

  it('accepts the waiver once the workspace is funded and entitled', async () => {
    const workspaceId = `ws_review_gate_allowed_${Date.now()}`
    const { version } = seedReviewableVersion(workspaceId)
    const base = await start()
    // The fixture header grants points and the continuous entitlement before
    // the request is dispatched, which is how every other funded e2e path
    // reaches its handler.
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'review-gate-actor', 'x-test-commercial-fixture': 'server-e2e' }
    const finding = (await reviewReport(base, headers, version.id)).body.data!.findings.find(item => item.code === 'DUPLICATE_IMAGE')!

    const decided = await mcp(base, headers, 1, 'content.review.decide', {
      content_version_id: version.id, code: finding.code, field: finding.field, status: 'waived', reason: '候选图用于内部对比', expected_revision: String(version.revision),
    })
    expect(decided.body.error).toBeNull()
    expect(decided.body.data!.result.decision).toMatchObject({ status: 'waived', reason: '候选图用于内部对比' })
  })

  it('denies delivery.bundle.verify for a workspace whose commercial facts are unknown', async () => {
    const workspaceId = `ws_bundle_gate_${Date.now()}`
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'review-gate-actor' }

    const verified = await mcp(base, headers, 1, 'delivery.bundle.verify', {
      manifest_json: JSON.stringify({ scope: { workspaceId }, files: [] }), files_json: '[]', expected_manifest_hash: `sha256:${'a'.repeat(64)}`,
    })
    expect(verified.body.error).toMatchObject({ code: 'CREATIVE_POINTS_UNAVAILABLE' })
  })

  it('keeps the cross-workspace manifest denial ahead of the commercial gate', async () => {
    const workspaceId = `ws_bundle_scope_${Date.now()}`
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'review-gate-actor' }

    const verified = await mcp(base, headers, 1, 'delivery.bundle.verify', {
      manifest_json: JSON.stringify({ scope: { workspaceId: `ws_bundle_foreign_${Date.now()}` }, marker: 'foreign-secret' }),
      files_json: '[]', expected_manifest_hash: `sha256:${'a'.repeat(64)}`,
    })
    expect(verified.body.error).toMatchObject({ code: 'TENANT_SCOPE_DENIED' })
    expect(verified.status).toBe(403)
  })

  it('keeps the entitlement grant helper and the funded fixture aligned', async () => {
    const workspaceId = `ws_review_gate_entitlement_${Date.now()}`
    await grantCreativePointsForTests(workspaceId, 100)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    const { version } = seedReviewableVersion(workspaceId)
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'review-gate-actor' }
    const finding = (await reviewReport(base, headers, version.id)).body.data!.findings.find(item => item.code === 'DUPLICATE_IMAGE')!

    const decided = await mcp(base, headers, 1, 'content.review.decide', {
      content_version_id: version.id, code: finding.code, field: finding.field, status: 'waived', reason: '已购套餐后接受风险', expected_revision: String(version.revision),
    })
    expect(decided.body.error).toBeNull()
    expect(decided.body.data!.result.decision).toMatchObject({ status: 'waived' })
  })
})
