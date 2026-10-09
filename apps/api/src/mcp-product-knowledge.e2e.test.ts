import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { projectImportedProductsToKnowledge } from '../../../packages/application/src/knowledge-import.js'

type Envelope<T = unknown> = {
  workspace_id: string
  data: { jsonrpc: '2.0'; id: string; result: T } | null
  error: { code: string; message?: string; details?: Record<string, unknown> } | null
}

let api: typeof import('./server.js')
let base = ''

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    api.server.once('error', onError)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', onError); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function callMcp<T = unknown>(token: string, workspaceId: string, method: string, params: Record<string, unknown> = {}, paramsWorkspaceId = workspaceId) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { workspace_id: paramsWorkspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as Envelope<T> }
}

function resultOf<T>(response: { status: number; body: Envelope<T> }): T {
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body.error).toBeNull()
  expect(response.body.data).not.toBeNull()
  return response.body.data!.result
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'mcp-product-knowledge-session-secret')
  api = await import('./server.js')
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('workspace and product scoped product knowledge MCP contract', () => {
  it('returns stable product-facts handles and requires authorized, audited revision-CAS approval without setting index ready', async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const workspaceId = `ws_product_knowledge_${suffix}`
    const otherWorkspaceId = `ws_product_knowledge_other_${suffix}`
    const ownerActor = `knowledge-owner-${suffix}`
    const editorActor = `knowledge-editor-${suffix}`
    const readerActor = `knowledge-reader-${suffix}`
    const deniedActor = `knowledge-denied-${suffix}`
    const nonMemberActor = `knowledge-not-member-${suffix}`
    const tokens = {
      owner: `knowledge-owner-token-${suffix}`,
      editor: `knowledge-editor-token-${suffix}`,
      reader: `knowledge-reader-token-${suffix}`,
      denied: `knowledge-denied-token-${suffix}`,
      nonMember: `knowledge-not-member-token-${suffix}`,
    }
    await Promise.all([
      api.workspaceMembers.upsert({ workspaceId, externalSubject: ownerActor, displayName: ownerActor, role: 'workspace_owner', status: 'active', invitedBy: 'mcp-product-knowledge-e2e' }),
      api.workspaceMembers.upsert({ workspaceId, externalSubject: editorActor, displayName: editorActor, role: 'support', status: 'active', invitedBy: 'mcp-product-knowledge-e2e' }),
      api.workspaceMembers.upsert({ workspaceId, externalSubject: readerActor, displayName: readerActor, role: 'support', status: 'active', invitedBy: 'mcp-product-knowledge-e2e' }),
      api.workspaceMembers.upsert({ workspaceId, externalSubject: deniedActor, displayName: deniedActor, role: 'support', status: 'active', invitedBy: 'mcp-product-knowledge-e2e' }),
    ])
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [tokens.owner]: { workspaces: [workspaceId], actor_id: ownerActor, roles: ['workspace_owner'] },
      [tokens.editor]: { workspaces: [workspaceId], actor_id: editorActor, roles: ['knowledge_editor'] },
      [tokens.reader]: { workspaces: [workspaceId], actor_id: readerActor, roles: ['knowledge_reader'] },
      [tokens.denied]: { workspaces: [workspaceId], actor_id: deniedActor, roles: ['viewer'] },
      [tokens.nonMember]: { workspaces: [workspaceId], actor_id: nonMemberActor, roles: ['knowledge_editor'] },
    }))

    base = await start()
    const product = api.service.importProduct({ workspaceId, platform: 'jd', localProductKey: `manual-${suffix}`, title: '契约测试商品', category: '服饰', price: 199, stock: 8 })
    const repository = api.knowledgeDocumentsForTests
    await projectImportedProductsToKnowledge({ repository, workspaceId, products: [product], sourceMetadata: { source: 'manual-review-fixture' } })
    const foreignProduct = api.service.importProduct({ workspaceId: otherWorkspaceId, platform: 'jd', localProductKey: `foreign-${suffix}`, title: '另一租户商品' })
    await projectImportedProductsToKnowledge({ repository, workspaceId: otherWorkspaceId, products: [foreignProduct], sourceMetadata: { source: 'foreign-review-fixture' } })
    const siblingProduct = api.service.importProduct({ workspaceId, platform: 'jd', localProductKey: `sibling-${suffix}`, title: '同租户另一商品' })
    const siblingKnowledge = await projectImportedProductsToKnowledge({ repository, workspaceId, products: [siblingProduct], sourceMetadata: { source: 'sibling-review-fixture' } })
    // Strict MCP dispatch hides products outside a member's canonical brand
    // scope before the knowledge handler runs. Build the same real catalog
    // mapping and grants used by production authorization fixtures.
    const brandId = `knowledge-review-${suffix}`
    resultOf(await callMcp(tokens.owner, workspaceId, 'brand-unit.create', { brand_id: brandId, name: `知识审核测试品-${suffix}` }))
    for (const scopedProduct of [product, siblingProduct]) {
      resultOf(await callMcp(tokens.owner, workspaceId, 'catalog.facts.confirm', { product_id: scopedProduct.id }))
      resultOf(await callMcp(tokens.owner, workspaceId, 'brand-unit.product.create', { brand_id: brandId, title: scopedProduct.title, source_product_id: scopedProduct.id }))
    }
    for (const [actorId, role] of [[readerActor, 'viewer'], [editorActor, 'editor'], [deniedActor, 'viewer']] as const) {
      resultOf(await callMcp(tokens.owner, workspaceId, 'brand-unit.access.grant', { brand_id: brandId, external_subject: actorId, role, reason: '商品知识 E2E 按真实品权限授权' }))
    }

    const listed = resultOf<{ workspaceId: string; productId: string; assets: Array<Record<string, unknown>>; documents: Array<Record<string, unknown>> }>(await callMcp(tokens.reader, workspaceId, 'knowledge.product.list', { product_id: product.id }))
    expect(listed).toMatchObject({ workspaceId, productId: product.id })
    expect(listed.assets).toHaveLength(1)
    expect(listed.assets[0]).toMatchObject({ productId: product.id, kind: 'product_facts', approvalStatus: 'pending', rightsStatus: 'unknown', indexState: 'queued', revision: 1 })
    expect(listed.assets[0]?.id).toEqual(expect.any(String))
    expect(listed.documents).toHaveLength(1)
    // The importer creates the document at revision 1, then persists its initial
    // lexical chunk set, which advances the document revision to 2. Asset CAS
    // remains independent and starts at revision 1.
    expect(listed.documents[0]).toMatchObject({ assetId: listed.assets[0]?.id, productId: product.id, approvalStatus: 'pending', rightsStatus: 'unknown', indexState: 'queued', revision: 2 })
    expect(listed.documents[0]).toMatchObject({ extractedText: expect.stringContaining('契约测试商品'), contentHash: expect.any(String) })

    const missingProduct = await callMcp(tokens.reader, workspaceId, 'knowledge.product.list')
    expect(missingProduct.body.error?.code).toBe('INVALID_REQUEST')
    const crossWorkspace = await callMcp(tokens.reader, workspaceId, 'knowledge.product.list', { product_id: foreignProduct.id })
    // Cross-workspace identifiers are concealed as not found, so this probe
    // cannot reveal whether the foreign product exists in another tenant.
    expect(crossWorkspace.status).toBe(404)
    expect(crossWorkspace.body.error?.code).toBe('PRODUCT_NOT_FOUND')
    expect(JSON.stringify(crossWorkspace.body.error)).not.toContain(foreignProduct.id)

    const assetId = String(listed.assets[0]?.id)
    type ApprovalResult = { id: string; productId: string; approvalStatus: string; rightsStatus: string; revision: number; documents: Array<Record<string, unknown>> }
    const approval = await callMcp<ApprovalResult>(tokens.editor, workspaceId, 'knowledge.product.update', {
      product_id: product.id, asset_id: assetId, expected_revision: '1', approval_status: 'approved', rights_status: 'cleared',
      reason: '商家提供授权说明并核对本商品事实',
    })
    const updated = resultOf<ApprovalResult>(approval)
    expect(updated).toMatchObject({ id: assetId, productId: product.id, approvalStatus: 'approved', rightsStatus: 'cleared', revision: 2 })
    expect(updated.documents).toHaveLength(1)
    expect(updated.documents[0]).toMatchObject({ approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'queued', revision: 3 })

    const readerWrite = await callMcp(tokens.reader, workspaceId, 'knowledge.product.update', { product_id: product.id, asset_id: assetId, expected_revision: '2', approval_status: 'rejected', reason: '知识读者不能更改审核状态' })
    expect(readerWrite.status).toBe(403)
    expect(readerWrite.body.error?.code).toBe('FORBIDDEN')
    const viewerWrite = await callMcp(tokens.denied, workspaceId, 'knowledge.product.update', { product_id: product.id, asset_id: assetId, expected_revision: '2', approval_status: 'rejected', reason: '当前角色不能更改审核状态' })
    expect(viewerWrite.status).toBe(403)
    expect(viewerWrite.body.error?.code).toBe('FORBIDDEN')

    const stale = await callMcp(tokens.editor, workspaceId, 'knowledge.product.update', { product_id: product.id, asset_id: assetId, expected_revision: '1', approval_status: 'pending', reason: '测试并发版本冲突行为' })
    expect(stale.body.error?.code).toBe('KNOWLEDGE_ASSET_REVISION_CONFLICT')
    // Use a real, separately authorized product so global brand-scope
    // preflight allows dispatch and the knowledge handler verifies the
    // asset/product binding without exposing an inaccessible product id.
    const wrongProduct = await callMcp(tokens.editor, workspaceId, 'knowledge.product.update', { product_id: siblingProduct.id, asset_id: assetId, expected_revision: '2', approval_status: 'pending', reason: '测试商品范围不能跨越' })
    expect(wrongProduct.body.error?.code).toBe('KNOWLEDGE_PRODUCT_ASSET_NOT_FOUND')
    const crossProductAsset = await callMcp(tokens.editor, workspaceId, 'knowledge.product.update', { product_id: product.id, asset_id: siblingKnowledge.assets[0]!.id, expected_revision: '1', approval_status: 'approved', reason: '测试资产不能跨商品审批' })
    expect(crossProductAsset.body.error?.code).toBe('KNOWLEDGE_PRODUCT_ASSET_NOT_FOUND')
    const denied = await callMcp(tokens.denied, workspaceId, 'knowledge.product.update', { product_id: product.id, asset_id: assetId, expected_revision: '2', approval_status: 'pending', reason: '测试未授权角色写入应被拒绝' })
    expect(denied.body.error?.code).toBe('FORBIDDEN')
    const nonMember = await callMcp(tokens.nonMember, workspaceId, 'knowledge.product.update', { product_id: product.id, asset_id: assetId, expected_revision: '2', approval_status: 'pending', reason: '测试无成员身份不能审批' })
    // Generic workspace/brand authorization rejects non-members before the
    // handler and must not disclose whether this product or asset exists.
    expect(nonMember.status).toBe(403)
    expect(nonMember.body.error?.code).toBe('WORKSPACE_MEMBERSHIP_REQUIRED')
    expect(JSON.stringify(nonMember.body.error)).not.toContain(product.id)
    const invalidRights = await callMcp(tokens.editor, workspaceId, 'knowledge.product.update', { product_id: product.id, asset_id: assetId, expected_revision: '2', rights_status: 'approved', reason: '测试未知权益值应被拒绝' })
    expect(invalidRights.body.error?.code).toBe('INVALID_REQUEST')
    const indexMutation = await callMcp(tokens.editor, workspaceId, 'knowledge.product.update', { product_id: product.id, asset_id: assetId, expected_revision: '2', approval_status: 'approved', index_state: 'ready', reason: '测试接口不可直接改索引状态' })
    expect(indexMutation.body.error?.code).toBe('INVALID_REQUEST')

    const finalList = resultOf<typeof listed>(await callMcp(tokens.reader, workspaceId, 'knowledge.product.list', { product_id: product.id }))
    expect(finalList.assets[0]).toMatchObject({ id: assetId, approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'queued', revision: 2 })
    expect(finalList.documents[0]).toMatchObject({ approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'queued', revision: 3 })
    const approvalAudits = (await api.operationAudits.list(workspaceId)).filter(audit => audit.action === 'knowledge.product.update' && audit.resourceId === assetId)
    expect(approvalAudits).toHaveLength(1)
    expect(approvalAudits[0]).toMatchObject({
      workspaceId,
      actorId: editorActor,
      action: 'knowledge.product.update',
      resourceType: 'knowledge_product_asset',
      resourceId: assetId,
      before: { approvalStatus: 'pending', rightsStatus: 'unknown', revision: 1 },
      after: { approvalStatus: 'approved', rightsStatus: 'cleared', revision: 2 },
      reason: '商家提供授权说明并核对本商品事实',
    })
  })
})
