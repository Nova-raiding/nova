import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { MemoryInteractiveConfirmationTicketRepository, type InteractiveConfirmationTicketRepository } from '../../../packages/persistence/src/interactive-confirmation-ticket-repository.js'

let server: typeof import('./server.js').server
let service: typeof import('./server.js').service
let securityAuditEventsForTests: typeof import('./server.js').securityAuditEventsForTests
let setImageSelectionTicketRepositoryForTests: typeof import('./server.js').setImageSelectionTicketRepositoryForTests
let imageSelectionEventsForTests: typeof import('./server.js').imageSelectionEventsForTests

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

describe('product image review API', () => {
  beforeAll(async () => { const module = await import('./server.js'); server = module.server; service = module.service; securityAuditEventsForTests = module.securityAuditEventsForTests; setImageSelectionTicketRepositoryForTests = module.setImageSelectionTicketRepositoryForTests; imageSelectionEventsForTests = module.imageSelectionEventsForTests })
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); setImageSelectionTicketRepositoryForTests(); vi.unstubAllEnvs() })

  it('returns deterministic findings and external verification boundaries', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_image_review' }
    const imported = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: '主图检查商品', local_product_key: 'image-review', category: '服装', price: 99, stock: 5, images: ['http://unsafe.example/main.jpg'] }) }).then(response => response.json()) as { data: { id: string } }
    const reviewed = await fetch(`${base}/v1/products/${encodeURIComponent(imported.data.id)}/image-review`, { headers: { 'x-workspace-id': 'ws_image_review' } }).then(response => response.json()) as { data: { findings: Array<{ code: string; severity: string }>; externallyUnverified: string[] } }
    expect(reviewed.data.findings).toEqual([expect.objectContaining({ code: 'IMAGE_URL_INVALID', severity: 'error' })])
    expect(reviewed.data.externallyUnverified).toContain('尺寸/清晰度')
  })

  it('generates, stores and reviews main-image variants through MCP', async () => {
    const base = await start()
    vi.stubEnv('PUBLIC_ASSET_BASE_URL', base)
    vi.stubEnv('ASSET_DISPLAY_URL_SIGNING_SECRET', 'test-asset-display-signing-secret-at-least-32-bytes')
    vi.stubEnv('ASSET_DISPLAY_URL_SIGNING_KEY_ID', 'test-primary')
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'catalog.image.generate', params: { product_id: 'prod_fixture_1', count: '2', direction: '白底主图' } }),
    }).then(value => value.json()) as { data: { result: { job_id: string; execution: { mode: string; simulated: boolean; providerExecuted: boolean; label: string }; product_protection: { policy: string; allowed: boolean; immutableAttributes: string[]; safeModifications: string[] }; job: { state: string; artifactRole: string; archiveState: string; candidates: Array<{ visualRef: string; assetId: string; scanStatus: string }> }; product: { images?: string[] }; images?: string[]; review?: unknown[] } } }
    expect(response.data.result.execution).toMatchObject({ mode: 'simulated', simulated: true, providerExecuted: false, label: '本地演示图片，未调用图片模型' })
    expect(response.data.result.job.state).toBe('succeeded')
    expect(response.data.result.job).toMatchObject({ artifactRole: 'candidate', archiveState: 'archived' })
    expect(response.data.result.job.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: expect.any(String), scanStatus: 'quarantined' })]))
    const candidateAssetId = response.data.result.job.candidates[0]!.assetId
    const scanned = await Promise.all(response.data.result.job.candidates.map(candidate => fetch(`${base}/v1/assets/${encodeURIComponent(candidate.assetId)}/scan`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ scan_evidence_ref: `scanner://generated-image-e2e/${candidate.assetId}` }) }).then(value => value.json()) as Promise<{ data: { scanStatus: string } }>))
    expect(scanned.every(item => item.data.scanStatus === 'clean')).toBe(true)
    const cleanJob = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'catalog.image.get', params: { visual_ref: response.data.result.job.candidates[0]!.visualRef } }) }).then(value => value.json()) as { data: { result: { images: string[]; image_urls: string[]; selection_tickets: Array<{ visual_ref: string; nonce_hash: string; intent_hash: string; expires_at: string }>; review: unknown[]; job: { revision: number; candidates: Array<{ assetId: string; scanStatus: string; visualRef: string }> } } } }
    expect(cleanJob.data.result.job.candidates[0]).toMatchObject({ assetId: candidateAssetId, scanStatus: 'clean' })
    expect(response.data.result.images).toBeUndefined()
    expect(cleanJob.data.result.images).toHaveLength(1)
    expect(response.data.result.product.images).not.toEqual(cleanJob.data.result.images)
    expect(cleanJob.data.result.images[0]).toMatch(/^data:image\/webp;base64,/u)
    expect(cleanJob.data.result.image_urls).toHaveLength(1)
    expect(cleanJob.data.result.selection_tickets).toEqual([{ visual_ref: response.data.result.job.candidates[0]!.visualRef, nonce_hash: expect.stringMatching(/^[a-f0-9]{64}$/u), intent_hash: expect.stringMatching(/^[a-f0-9]{64}$/u), expires_at: expect.any(String) }])
    expect(Date.parse(cleanJob.data.result.selection_tickets[0]!.expires_at) - Date.now()).toBeGreaterThan(4 * 60_000)
    expect(new URL(cleanJob.data.result.image_urls[0]!).searchParams.get('kid')).toBe('test-primary')
    expect(new URL(cleanJob.data.result.image_urls[0]!).searchParams.get('v')).toBe('1')
    const displayed = await fetch(cleanJob.data.result.image_urls[0]!)
    expect(displayed.status).toBe(200)
    expect(displayed.headers.get('content-type')).toBe('image/webp')
    expect(displayed.headers.get('cache-control')).toContain('no-store')
    expect(displayed.headers.get('x-content-type-options')).toBe('nosniff')
    expect(displayed.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(displayed.headers.get('referrer-policy')).toBe('no-referrer')
    expect(new Uint8Array(await displayed.arrayBuffer()).byteLength).toBeGreaterThan(0)
    vi.stubEnv('ASSET_DISPLAY_URL_SIGNING_SECRET', 'rotated-test-display-signing-secret-at-least-32-bytes')
    vi.stubEnv('ASSET_DISPLAY_URL_SIGNING_KEY_ID', 'test-rotated')
    vi.stubEnv('ASSET_DISPLAY_URL_PREVIOUS_KEYS_JSON', JSON.stringify({ 'test-primary': 'test-asset-display-signing-secret-at-least-32-bytes' }))
    expect((await fetch(cleanJob.data.result.image_urls[0]!)).status).toBe(200)
    const unknownKid = new URL(cleanJob.data.result.image_urls[0]!)
    unknownKid.searchParams.set('kid', 'unknown-key')
    expect((await fetch(unknownKid)).status).toBe(403)
    const tampered = new URL(cleanJob.data.result.image_urls[0]!)
    tampered.searchParams.set('workspace_id', 'ws_other')
    expect((await fetch(tampered)).status).toBe(403)
    const expired = new URL(cleanJob.data.result.image_urls[0]!)
    expired.searchParams.set('expires', '1')
    expect((await fetch(expired)).status).toBe(403)
    expect(cleanJob.data.result.review).toEqual([])
    const publishJobsBeforePreference = [...service.publishJobs.values()].filter(job => job.workspaceId === 'ws_demo').length
    const firstTicket = cleanJob.data.result.selection_tickets[0]!
    const missingTicket = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 48, method: 'catalog.image.select', params: { job_id: response.data.result.job_id, visual_ref: response.data.result.job.candidates[0]!.visualRef, expected_revision: String(cleanJob.data.result.job.revision), idempotency_key: 'image-ticket-missing', reason: '缺少票据' } }) }).then(value => value.json()) as { error: { code: string } }
    expect(missingTicket.error.code).toBe('INVALID_REQUEST')
    const candidateMismatch = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 49, method: 'catalog.image.select', params: { job_id: response.data.result.job_id, visual_ref: response.data.result.job.candidates[1]!.visualRef, expected_revision: String(cleanJob.data.result.job.revision), idempotency_key: 'image-ticket-candidate-mismatch', reason: '错误候选绑定', confirmation_ticket_nonce_hash: firstTicket.nonce_hash, confirmation_ticket_intent_hash: firstTicket.intent_hash } }) }).then(value => value.json()) as { error: { code: string } }
    expect(candidateMismatch.error.code).toBe('INTERACTIVE_CONFIRMATION_INTENT_MISMATCH')
    const revisionMismatch = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'catalog.image.select', params: { job_id: response.data.result.job_id, visual_ref: response.data.result.job.candidates[0]!.visualRef, expected_revision: String(cleanJob.data.result.job.revision + 1), idempotency_key: 'image-ticket-revision-mismatch', reason: '错误版本绑定', confirmation_ticket_nonce_hash: firstTicket.nonce_hash, confirmation_ticket_intent_hash: firstTicket.intent_hash } }) }).then(value => value.json()) as { error: { code: string } }
    expect(revisionMismatch.error.code).toBe('INTERACTIVE_CONFIRMATION_INTENT_MISMATCH')
    const preferred = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'catalog.image.select', params: { job_id: response.data.result.job_id, visual_ref: response.data.result.job.candidates[0]!.visualRef, expected_revision: String(cleanJob.data.result.job.revision), idempotency_key: 'image-card-preference-e2e', reason: 'ChatGPT 卡片明确选择', confirmation_ticket_nonce_hash: firstTicket.nonce_hash, confirmation_ticket_intent_hash: firstTicket.intent_hash } }) }).then(value => value.json()) as { data: { result: { preference_status: string; review_status: string; currently_usable: boolean; publishable: boolean; review_required: boolean; platformPublished: boolean; remote_write_performed: boolean; revision: number; idempotent_replay: boolean } } }
    expect(preferred.data.result).toMatchObject({ preference_status: 'selected', review_status: 'unreviewed', currently_usable: true, publishable: false, review_required: true, platformPublished: false, remote_write_performed: false, idempotent_replay: false })
    expect(JSON.stringify(imageSelectionEventsForTests('ws_demo').at(-1))).not.toMatch(/confirmation_ticket|nonce_hash|nonceHash/u)
    const replayedPreference = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 52, method: 'catalog.image.select', params: { job_id: response.data.result.job_id, visual_ref: response.data.result.job.candidates[0]!.visualRef, expected_revision: String(cleanJob.data.result.job.revision), idempotency_key: 'image-card-preference-e2e', reason: 'ChatGPT 卡片明确选择', confirmation_ticket_nonce_hash: firstTicket.nonce_hash, confirmation_ticket_intent_hash: firstTicket.intent_hash } }) }).then(value => value.json()) as { data: { result: { revision: number; idempotent_replay: boolean } } }
    expect(replayedPreference.data.result).toMatchObject({ revision: preferred.data.result.revision, idempotent_replay: true })
    const consumedTicketDifferentWrite = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 52.1, method: 'catalog.image.select', params: { job_id: response.data.result.job_id, visual_ref: response.data.result.job.candidates[0]!.visualRef, expected_revision: String(cleanJob.data.result.job.revision), idempotency_key: 'image-card-preference-new-write', reason: '新的写操作不可重放旧票据', confirmation_ticket_nonce_hash: firstTicket.nonce_hash, confirmation_ticket_intent_hash: firstTicket.intent_hash } }) }).then(value => value.json()) as { error: { code: string } }
    expect(consumedTicketDifferentWrite.error.code).toBe('INTERACTIVE_CONFIRMATION_TICKET_INVALID')
    expect([...service.publishJobs.values()].filter(job => job.workspaceId === 'ws_demo')).toHaveLength(publishJobsBeforePreference)
    const restoredPreference = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 53, method: 'catalog.image.get', params: { job_id: response.data.result.job_id } }) }).then(value => value.json()) as { data: { result: { selection_tickets: Array<{ visual_ref: string; nonce_hash: string; intent_hash: string }>; job: { revision: number; preferredCandidate: { visualRef: string; status: string; platformPublished: boolean } } } } }
    expect(restoredPreference.data.result.job.preferredCandidate).toMatchObject({ visualRef: response.data.result.job.candidates[0]!.visualRef, status: 'preferred', platformPublished: false })
    const concurrentTicket = restoredPreference.data.result.selection_tickets.find(ticket => ticket.visual_ref === response.data.result.job.candidates[1]!.visualRef)!
    const concurrentCall = (id: number, key: string, reason: string) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'catalog.image.select', params: { job_id: response.data.result.job_id, visual_ref: concurrentTicket.visual_ref, expected_revision: String(restoredPreference.data.result.job.revision), idempotency_key: key, reason, confirmation_ticket_nonce_hash: concurrentTicket.nonce_hash, confirmation_ticket_intent_hash: concurrentTicket.intent_hash } }) }).then(value => value.json()) as Promise<{ data: { result: { preference_status: string } } | null; error: { code: string } | null }>
    const concurrent = await Promise.all([concurrentCall(54, 'image-ticket-race-a', '并发选择 A'), concurrentCall(55, 'image-ticket-race-b', '并发选择 B')])
    expect(concurrent.filter(item => item.data?.result.preference_status === 'selected')).toHaveLength(1)
    expect(concurrent.filter(item => item.error?.code === 'INTERACTIVE_CONFIRMATION_TICKET_INVALID')).toHaveLength(1)
    expect(response.data.result.product_protection).toMatchObject({ policy: 'protected-product-intent-v1', allowed: true, immutableAttributes: expect.arrayContaining(['color', 'structure', 'material', 'logo', 'packaging_text', 'certification_mark', 'accessories']), safeModifications: [] })
    expect(JSON.stringify(response.data.result.product_protection)).not.toMatch(/evidence|promptConstraints|instructionZh|instructionEn/u)
    expect(JSON.stringify(response.data.result.job)).not.toMatch(/storageKey|sha256|data:image/u)

    const historical = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'catalog.image.get', params: { visual_ref: response.data.result.job.candidates[0]!.visualRef } }),
    }).then(value => value.json()) as { data: { result: { images: string[]; historicalCandidate: boolean; platformPublished: boolean } } }
    expect(historical.data.result).toMatchObject({ historicalCandidate: true, platformPublished: false })
    expect(historical.data.result.images).toHaveLength(1)

    const allClean = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'catalog.image.get', params: { job_id: response.data.result.job_id } }) }).then(value => value.json()) as { data: { result: { images: string[] } } }
    expect(allClean.data.result.images).toHaveLength(2)

    const reviewedDelimited = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'catalog.image.review', params: { product_id: 'prod_fixture_1', images: allClean.data.result.images.join(',') } }),
    }).then(value => value.json()) as { data: { result: { images: string[]; findings: unknown[] } } }
    expect(reviewedDelimited.data.result.images).toHaveLength(2)
    expect(reviewedDelimited.data.result.findings).toEqual([])

    const reviewedJson = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'catalog.image.review', params: { product_id: 'prod_fixture_1', images: JSON.stringify(allClean.data.result.images) } }),
    }).then(value => value.json()) as { data: { result: { images: string[]; findings: unknown[] } } }
    expect(reviewedJson.data.result.images).toHaveLength(2)
    expect(reviewedJson.data.result.findings).toEqual([])
  })

  it('uses the same archive evidence gate for image reads and candidate selection', async () => {
    const base = await start()
    const workspaceId = `ws_image_integrity_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'integrity-e2e' }
    const product = service.importProduct({ workspaceId, platform: 'taobao', localProductKey: 'image-integrity', title: '归档一致性商品', stock: 3 })
    service.confirmProductFacts(workspaceId, product.id)
    const call = (id: number, method: string, params: Record<string, string>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(response => response.json()) as Promise<any>
    const generated = await call(1, 'catalog.image.generate', { product_id: product.id, count: '1', idempotency_key: `integrity-generate-${workspaceId}` })
    const jobId = generated.data.result.job_id as string
    const candidate = generated.data.result.job.candidates[0] as { assetId: string; visualRef: string }
    await fetch(`${base}/v1/assets/${encodeURIComponent(candidate.assetId)}/scan`, { method: 'POST', headers, body: JSON.stringify({ scan_evidence_ref: `scanner://integrity/${candidate.assetId}` }) })
    const job = service.getImageGenerationJob(workspaceId, jobId)
    const readable = await call(1.5, 'catalog.image.get', { job_id: jobId })
    const ticket = readable.data.result.selection_tickets[0] as { nonce_hash: string; intent_hash: string }
    job.outputs![0]!.archiveReceiptDigest = '0'.repeat(64)

    const unreadable = await call(2, 'catalog.image.get', { job_id: jobId })
    expect(unreadable.data.result).toMatchObject({ availabilityWarning: expect.any(String) })
    expect(unreadable.data.result.images).toBeUndefined()
    expect(unreadable.data.result.selection_tickets).toBeUndefined()
    const denied = await call(3, 'catalog.image.select', { job_id: jobId, visual_ref: candidate.visualRef, expected_revision: String(job.revision), idempotency_key: `integrity-select-${workspaceId}`, reason: '尝试选择收据不一致候选', confirmation_ticket_nonce_hash: ticket.nonce_hash, confirmation_ticket_intent_hash: ticket.intent_hash })
    expect(denied.error).toMatchObject({ code: 'VISUAL_ARCHIVE_INTEGRITY_FAILED', details: { reason: 'archive_receipt_mismatch' } })
    expect(job.preferredSelection).toBeUndefined()
  })

  it('stores only a nonce digest and rejects cross-session or expired image selection tickets', async () => {
    let clock = new Date()
    const memory = new MemoryInteractiveConfirmationTicketRepository(() => clock)
    const issued: Parameters<InteractiveConfirmationTicketRepository['issue']>[0][] = []
    const recordingRepository: InteractiveConfirmationTicketRepository = {
      issue: async input => { issued.push(structuredClone(input)); return memory.issue(input) },
      consume: input => memory.consume(input),
    }
    setImageSelectionTicketRepositoryForTests(recordingRepository)
    const base = await start()
    const workspaceId = `ws_image_ticket_expiry_${Date.now()}`
    const actorHeaders = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'ticket-owner' }
    const otherHeaders = { ...actorHeaders, 'x-actor-id': 'ticket-other' }
    const product = service.importProduct({ workspaceId, platform: 'taobao', localProductKey: 'ticket-expiry', title: '票据过期商品', stock: 2 })
    service.confirmProductFacts(workspaceId, product.id)
    const call = (headers: Record<string, string>, id: number, method: string, params: Record<string, string>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(response => response.json()) as Promise<any>
    const generated = await call(actorHeaders, 1, 'catalog.image.generate', { product_id: product.id, count: '1', idempotency_key: `ticket-expiry-${workspaceId}` })
    const jobId = generated.data.result.job_id as string
    const candidate = generated.data.result.job.candidates[0] as { assetId: string; visualRef: string }
    await fetch(`${base}/v1/assets/${encodeURIComponent(candidate.assetId)}/scan`, { method: 'POST', headers: actorHeaders, body: JSON.stringify({ scan_evidence_ref: `scanner://ticket-expiry/${candidate.assetId}` }) })
    const readable = await call(actorHeaders, 2, 'catalog.image.get', { job_id: jobId })
    const ticket = readable.data.result.selection_tickets[0] as { nonce_hash: string; intent_hash: string; expires_at: string }
    expect(issued).toHaveLength(1)
    expect(issued[0]!.nonceHash).toBe(createHash('sha256').update(ticket.nonce_hash).digest('hex'))
    expect(issued[0]!.nonceHash).not.toBe(ticket.nonce_hash)
    const selection = { job_id: jobId, visual_ref: candidate.visualRef, expected_revision: String(readable.data.result.job.revision), idempotency_key: `ticket-expiry-select-${workspaceId}`, reason: '测试会话与过期绑定', confirmation_ticket_nonce_hash: ticket.nonce_hash, confirmation_ticket_intent_hash: ticket.intent_hash }
    expect((await call(otherHeaders, 3, 'catalog.image.select', selection)).error.code).toBe('INTERACTIVE_CONFIRMATION_TICKET_INVALID')
    clock = new Date(Date.parse(ticket.expires_at) + 1)
    expect((await call(actorHeaders, 4, 'catalog.image.select', selection)).error.code).toBe('INTERACTIVE_CONFIRMATION_TICKET_INVALID')
    expect(service.getImageGenerationJob(workspaceId, jobId).preferredSelection).toBeUndefined()
  })

  it('fails closed on protected product mutations before wallet usage or image job/provider work', async () => {
    const base = await start()
    const workspaceId = `ws_protected_product_${Date.now()}`
    const product = service.importProduct({ workspaceId, platform: 'taobao', title: '受保护商品图片', category: '服装', stock: 6, price: 129 })
    service.confirmProductFacts(workspaceId, product.id)
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const mcp = (id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(response => response.json()) as Promise<any>
    const before = await mcp(1, 'billing.transactions', {})
    const jobsBefore = [...service.imageGenerationJobs.values()].filter(job => job.workspaceId === workspaceId).length

    const blockedGenerate = await mcp(2, 'catalog.image.generate', { product_id: product.id, count: '1', direction: '把商品颜色改成红色，结构拉长，材质换成金属，删除 Logo 和包装文字，移除认证标识并增加配件' })
    expect(blockedGenerate.error).toMatchObject({ code: 'PROTECTED_PRODUCT_MUTATION_BLOCKED', details: { product_protection: { allowed: false, blockedAttributes: expect.arrayContaining(['color', 'structure', 'material', 'logo', 'packaging_text', 'certification_mark', 'accessories']) } } })
    expect(JSON.stringify(blockedGenerate.error.details)).not.toMatch(/evidence|promptConstraints|instructionZh|instructionEn/u)

    const blockedEdit = await mcp(3, 'multimodal.image.edit', { request_json: JSON.stringify({ kind: 'image_local_edit', id: `edit-protected-${Date.now()}`, sourceImage: { id: 'asset-that-must-not-be-read', uri: 'asset://protected-source', width: 1200, height: 1200 }, prompt: '重写包装文字并移除认证标识', region: { id: 'product', rect: { x: 0, y: 0, width: 1, height: 1 } }, constraints: { editableRegions: [{ id: 'product', rect: { x: 0, y: 0, width: 1, height: 1 } }], nonModifiableRegions: [] }, context: { brand: { id: 'brand-1', version: '1', hash: 'sha256:brand' }, product: { id: product.id, version: String(product.version), hash: 'sha256:product' }, rules: [{ id: 'rule-1', version: '1', hash: 'sha256:rule' }] } }) })
    expect(blockedEdit.error).toMatchObject({ code: 'PROTECTED_PRODUCT_MUTATION_BLOCKED', details: { product_protection: { allowed: false, blockedAttributes: expect.arrayContaining(['packaging_text', 'certification_mark']) } } })

    const after = await mcp(4, 'billing.transactions', {})
    expect(after.data.result.transactions).toEqual(before.data.result.transactions)
    expect([...service.imageGenerationJobs.values()].filter(job => job.workspaceId === workspaceId)).toHaveLength(jobsBefore)

    const safe = await mcp(5, 'catalog.image.generate', { product_id: product.id, count: '1', direction: '更换海边场景，调整光影和构图，保持商品本体不变' })
    expect(safe.error).toBeNull()
    expect(safe.data.result.product_protection).toMatchObject({ allowed: true, safeModifications: expect.arrayContaining(['background', 'lighting', 'composition']), blockedAttributes: [] })
  })

  it('rejects an explicitly selected platform or store that conflicts with the product', async () => {
    const base = await start()
    const workspaceId = `ws_visual_scope_${Date.now()}`
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: 'store-taobao-a', localProductKey: 'visual-scope', title: '平台店铺边界商品', stock: 5, price: 99 })
    service.confirmProductFacts(workspaceId, product.id)
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const platformMismatch = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'catalog.image.generate', params: { product_id: product.id, platform: 'jd', count: '1' } }) }).then(response => response.json()) as { error: { code: string; details: Record<string, string> } }
    expect(platformMismatch.error).toMatchObject({ code: 'IMAGE_PLATFORM_SCOPE_MISMATCH', details: { product_platform: 'taobao', requested_platform: 'jd' } })
    const accountMismatch = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'catalog.image.generate', params: { product_id: product.id, platform: 'taobao', account_id: 'store-taobao-b', count: '1' } }) }).then(response => response.json()) as { error: { code: string; details: Record<string, string> } }
    expect(accountMismatch.error).toMatchObject({ code: 'IMAGE_ACCOUNT_SCOPE_MISMATCH', details: { product_account_id: 'store-taobao-a', requested_account_id: 'store-taobao-b' } })
  })

  it('reviews and selects a candidate into a new version, then blocks unsupported platform image upload', async () => {
    const workspaceId = `ws_visual_select_${Date.now()}`
    const product = service.importProduct({ workspaceId, platform: 'taobao', localProductKey: 'visual-select', title: '显式选图商品', stock: 8, images: ['https://example.com/original.jpg'], skus: [{ id: 'sku-visual-blue-m', name: '蓝色 / M', price: 129, stock: 8 }] })
    service.confirmProductFacts(workspaceId, product.id)
    const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    const originalImages = [...(product.images ?? [])]
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'merchant-visual-e2e' }
    const call = (id: number, method: string, params: Record<string, string>, extra: Record<string, string> = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }).then(response => response.json())

    const generated = await call(20, 'catalog.image.generate', { product_id: product.id, task_id: task.id, content_version_id: draft.id, count: '2', idempotency_key: 'visual-select-generate-e2e' }) as { data: { result: { job: { candidates: Array<{ visualRef: string; assetId?: string }> } } } }
    const refs = generated.data.result.job.candidates.map(candidate => candidate.visualRef)
    expect(refs).toHaveLength(2)
    expect(product.images).toEqual(originalImages)
    for (const candidate of generated.data.result.job.candidates) if (candidate.assetId) {
      const scanned = await fetch(`${base}/v1/assets/${encodeURIComponent(candidate.assetId)}/scan`, { method: 'POST', headers, body: JSON.stringify({ scan_evidence_ref: 'scanner://visual-select-e2e' }) }).then(response => response.json()) as { data: { scanStatus: string } }
      expect(scanned.data.scanStatus).toBe('clean')
    }

    const reviewed = await call(21, 'catalog.image.review', { product_id: product.id, visual_refs_json: JSON.stringify(refs) }) as { data: { result: { persistedReviewStatus: string } } }
    expect(reviewed.data.result.persistedReviewStatus).toBe('passed')
    const selected = await call(22, 'content.visual.select', { content_version_id: draft.id, visual_refs_json: JSON.stringify([refs[1], refs[0]]), expected_revision: String(draft.revision), idempotency_key: 'visual-select-e2e', reason: '第二张作为主图' }) as { data: { result: { content_version_id: string; parent_content_version_id: string; state: string; reviewRequired: boolean; approvalRequired: boolean; visualSelection: { items: Array<{ visualRef: string }> } } } }
    expect(selected.data.result).toMatchObject({ parent_content_version_id: draft.id, state: 'review_required', reviewRequired: true, approvalRequired: true, visualSelection: { items: [{ visualRef: refs[1] }, { visualRef: refs[0] }] } })
    expect(selected.data.result.content_version_id).not.toBe(draft.id)

    const rereviewed = await call(23, 'content.review', { content_version_id: selected.data.result.content_version_id }) as { data: { result: { blocking: boolean; findings: unknown[] } } }
    expect(rereviewed.data.result.blocking).toBe(false)
    expect(rereviewed.data.result.findings).not.toContainEqual(expect.objectContaining({ code: 'DETAIL_MODULE_OPTIONAL_OMITTED' }))
    const approved = await call(24, 'content.approve', { task_id: task.id, content_version_id: selected.data.result.content_version_id }) as { data: { result: { task: { state: string }; version: { state: string } } } }
    expect(approved.data.result).toMatchObject({ task: { state: 'approved' }, version: { state: 'approved' } })

    const preview = await call(25, 'publish.prepare', { task_id: task.id }) as { data: { result: { confirmationHash: string; remoteSnapshotHash: string; payloadHash: string; selectionHash: string; visualPreview: { imageMode: string; executionReady: boolean; blocker: string; items: Array<{ visualRef: string; firstIsMainImage: boolean }> } } } }
    expect(preview.data.result).toMatchObject({ selectionHash: expect.any(String), payloadHash: expect.any(String), visualPreview: { imageMode: 'replace_pending_adapter', executionReady: false, blocker: 'IMAGE_PUBLISH_ADAPTER_UNAVAILABLE', items: [{ visualRef: refs[1], role: 'main', firstIsMainImage: true }, { visualRef: refs[0], role: 'secondary', firstIsMainImage: false }] } })
    const pending = service.getTask(task.id).pendingPublish
    expect(pending).toMatchObject({ contentVersionId: selected.data.result.content_version_id, payloadSnapshot: { imageMode: 'replace_pending_adapter' }, selectedVisuals: [{ visualRef: refs[1], role: 'main', skuIds: expect.any(Array) }, { visualRef: refs[0], role: 'secondary', skuIds: expect.any(Array) }] })
    expect(pending?.payloadSnapshot.fields).not.toHaveProperty('images')
    expect(product.images).toEqual(originalImages)

    const confirmed = await call(26, 'publish.confirm', { task_id: task.id, content_version_id: selected.data.result.content_version_id, confirmation_hash: preview.data.result.confirmationHash, remote_snapshot_hash: preview.data.result.remoteSnapshotHash }, { 'idempotency-key': 'visual-publish-e2e' }) as { error: { code: string; message: string; details: { selected_count: number } } }
    expect(confirmed.error).toMatchObject({ code: 'IMAGE_PUBLISH_ADAPTER_UNAVAILABLE' })
    expect(confirmed.error.message).toContain('禁止退回旧商品图')
    expect(confirmed.error.details).toMatchObject({ selected_count: 2 })
    expect(service.getTask(task.id)).toMatchObject({ state: 'publish_prepared', pendingPublish: { confirmationHash: preview.data.result.confirmationHash } })
    expect([...service.publishJobs.values()].filter(job => job.workspaceId === workspaceId)).toHaveLength(0)
  })

  it('blocks formal image generation until an approved AI-editable asset matches the product platform', async () => {
    const previous = process.env.REQUIRE_APPROVED_ASSET_FOR_GENERATION
    const previousProfile = process.env.DEPLOYMENT_PROFILE
    const previousLocalCompose = process.env.LOCAL_COMPOSE
    const previousScanFixture = process.env.ALLOW_LOCAL_ASSET_SCAN_FIXTURE
    process.env.REQUIRE_APPROVED_ASSET_FOR_GENERATION = 'true'
    process.env.DEPLOYMENT_PROFILE = 'local_acceptance'
    process.env.LOCAL_COMPOSE = 'true'
    process.env.ALLOW_LOCAL_ASSET_SCAN_FIXTURE = 'true'
    try {
      const base = await start()
      const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_image_asset_gate' }
      const imported = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: '素材门禁商品', local_product_key: 'image-asset-gate', price: 99, stock: 5 }) }).then(response => response.json()) as { data: { id: string } }
      const confirmed = await fetch(`${base}/v1/products/${encodeURIComponent(imported.data.id)}/confirm`, { method: 'POST', headers, body: '{}' }).then(response => response.json()) as { data: { factsConfirmed: boolean } }
      expect(confirmed.data.factsConfirmed).toBe(true)

      const blocked = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'catalog.image.generate', params: { product_id: imported.data.id, count: '1' } }) }).then(response => response.json()) as { error: { code: string; message: string; details: { candidate_count: number; required: Record<string, unknown> } } }
      expect(blocked.error).toMatchObject({ code: 'APPROVED_ASSET_REQUIRED_FOR_GENERATION' })
      expect(blocked.error.message).toContain('已通过安全扫描')
      expect(blocked.error.details).toMatchObject({ candidate_count: 0, required: { scan_status: 'clean', rights_status: 'approved', ai_modification_allowed: true, applicable_platforms: ['taobao'] } })

      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
      const uploaded = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'asset.upload', params: { name: 'product-source.png', mime_type: 'image/png', content_base64: pngSignature.toString('base64'), applicable_platforms_json: '["taobao"]' } }) }).then(response => response.json()) as { data: { result: { id: string; scanStatus: string; scanAutomation: { mode: string; productionEvidence: boolean } } } }
      expect(uploaded.data.result).toMatchObject({ scanStatus: 'clean', scanAutomation: { mode: 'local_fixture', productionEvidence: false } })
      const rights = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'asset.rights.update', params: { asset_id: uploaded.data.result.id, rights_status: 'approved', rights_scope: 'commercial_authorized', applicable_platforms_json: '["taobao"]', ai_modification_allowed: 'true' } }) }).then(response => response.json()) as { data: { result: { rightsStatus: string; aiModificationAllowed: boolean } } }
      expect(rights.data.result).toMatchObject({ rightsStatus: 'approved', aiModificationAllowed: true })

      const generated = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'catalog.image.generate', params: { product_id: imported.data.id, mode: 'optimize', count: '1', asset_ids_json: JSON.stringify([uploaded.data.result.id]), idempotency_key: 'image-gate-approved-1' } }) }).then(response => response.json()) as { data: { result: { images: string[]; job: { imageMode: string; sourceAssetIds: string[] } } } }
      expect(generated.data.result.images).toHaveLength(1)
      expect(generated.data.result.job).toMatchObject({ imageMode: 'optimize', sourceAssetIds: [uploaded.data.result.id] })
      const bound = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: '默认素材商品', local_product_key: 'image-default-source', price: 109, stock: 5, asset_ids: [uploaded.data.result.id] }) }).then(response => response.json()) as { data: { id: string; sourceAssetIds: string[] } }
      expect(bound.data.sourceAssetIds).toEqual([uploaded.data.result.id])
      await fetch(`${base}/v1/products/${encodeURIComponent(bound.data.id)}/confirm`, { method: 'POST', headers, body: '{}' })
      const generatedFromDefault = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 16, method: 'catalog.image.generate', params: { product_id: bound.data.id, count: '1', idempotency_key: 'image-gate-default-source-1' } }) }).then(response => response.json()) as { data: { result: { images: string[]; job: { imageMode: string; sourceAssetIds: string[] } } } }
      expect(generatedFromDefault.data.result.images).toHaveLength(1)
      expect(generatedFromDefault.data.result.job).toMatchObject({ imageMode: 'optimize', sourceAssetIds: [uploaded.data.result.id] })
      const edited = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'multimodal.image.edit', params: { request_json: JSON.stringify({ kind: 'image_local_edit', id: 'edit-uploaded-source', sourceImage: { id: uploaded.data.result.id, uri: 'asset://workspace-source', width: 1200, height: 1200 }, prompt: '优化背景但保留商品结构', region: { id: 'background', rect: { x: 0, y: 0, width: 1, height: 1 } }, constraints: { editableRegions: [{ id: 'background', rect: { x: 0, y: 0, width: 1, height: 1 } }], nonModifiableRegions: [] }, context: { brand: { id: 'brand-1', version: '1', hash: 'sha256:brand' }, product: { id: bound.data.id, version: '1', hash: 'sha256:product' }, rules: [{ id: 'rule-1', version: '1', hash: 'sha256:rule' }] } }) } }) }).then(response => response.json()) as { data: { result: { sourceImageId: string; status: string; originalPreserved: boolean } } }
      expect(edited.data.result).toMatchObject({ sourceImageId: uploaded.data.result.id, status: 'candidate', originalPreserved: true })
    } finally {
      if (previous === undefined) delete process.env.REQUIRE_APPROVED_ASSET_FOR_GENERATION
      else process.env.REQUIRE_APPROVED_ASSET_FOR_GENERATION = previous
      if (previousProfile === undefined) delete process.env.DEPLOYMENT_PROFILE
      else process.env.DEPLOYMENT_PROFILE = previousProfile
      if (previousLocalCompose === undefined) delete process.env.LOCAL_COMPOSE
      else process.env.LOCAL_COMPOSE = previousLocalCompose
      if (previousScanFixture === undefined) delete process.env.ALLOW_LOCAL_ASSET_SCAN_FIXTURE
      else process.env.ALLOW_LOCAL_ASSET_SCAN_FIXTURE = previousScanFixture
    }
  })

  it('creates fact-bound Banner, ad and video briefs without pretending to render media', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_creative_brief' }
    const imported = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: 'Brief 商品', local_product_key: 'brief-product', price: 129, stock: 8, skus: [{ id: 'sku-blue', name: '雾蓝/M', price: 129, stock: 8 }] }) }).then(response => response.json()) as { data: { id: string } }
    await fetch(`${base}/v1/products/${encodeURIComponent(imported.data.id)}/confirm`, { method: 'POST', headers, body: '{}' })
    const banner = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'creative.brief', params: { product_id: imported.data.id, asset_type: 'banner', platform: 'taobao', sku_ids_json: '["sku-blue"]' } }) }).then(response => response.json()) as { data: { result: { assetType: string; renderable: boolean; dimensions: { ratio: string; resolution: string }; layout: { productBinding: Array<{ skuId: string }> } } } }
    expect(banner.data.result).toMatchObject({ assetType: 'banner', renderable: false, dimensions: { ratio: '3:1', resolution: '1200x400' }, layout: { productBinding: [{ skuId: 'sku-blue' }] } })
    const video = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'creative.brief', params: { product_id: imported.data.id, asset_type: 'video_storyboard', duration_seconds: '15' } }) }).then(response => response.json()) as { data: { result: { scenes: unknown[]; storyboardConfirmationRequired: boolean } } }
    expect(video.data.result.scenes).toHaveLength(4)
    expect(video.data.result.storyboardConfirmationRequired).toBe(true)
    const invalidPromotion = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'creative.brief', params: { product_id: imported.data.id, asset_type: 'ad', promotion_json: '{"price":99}' } }) }).then(response => response.json()) as { error: { code: string } }
    expect(invalidPromotion.error.code).toBe('PROMOTION_VALIDITY_REQUIRED')
    const preview = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'creative.preview', params: { product_id: imported.data.id, asset_type: 'banner', platform: 'taobao', count: '2' } }) }).then(response => response.json()) as { data: { result: { images: string[]; width: number; height: number; renderMode: string; externallyUnverified: string[] } } }
    expect(preview.data.result.images).toHaveLength(2)
    expect(preview.data.result).toMatchObject({ width: 1200, height: 400 })
    expect(preview.data.result.images[0]).toMatch(/^data:image\/svg\+xml;base64,/u)
    expect(preview.data.result.renderMode).toBe('deterministic_review_preview')
    expect(preview.data.result.externallyUnverified).toContain('OCR 与平台最终审核')
  })

  it('keeps brand and asset onboarding inside MCP', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_mcp_assets' }
    const brand = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'brand.upsert', params: { name: '云朵品牌', positioning: '轻户外', tone_json: '["克制","清晰"]' } }) }).then(response => response.json()) as { data: { result: { name: string; revision: number } } }
    expect(brand.data.result).toMatchObject({ name: '云朵品牌', revision: 1 })
    const encoded = Buffer.from('title: 轻量外套\nmaterial: 防晒面料').toString('base64')
    const uploaded = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'asset.upload', params: { name: 'facts.txt', mime_type: 'text/plain', content_base64: encoded, rights_scope: 'limited_use', applicable_platforms_json: '["taobao"]', applicable_regions_json: '["CN"," HK ","CN"]', usage_scopes_json: '["commercial","ai_generation"]', valid_from: '2026-01-01T00:00:00Z', valid_to: '2026-12-31T23:59:59Z', ai_modification_allowed: 'false' } }) }).then(response => response.json()) as { data: { result: { id: string; scanStatus: string; rightsScope: string; applicablePlatforms: string[]; applicableRegions: string[]; usageScopes: string[]; aiModificationAllowed: boolean } } }
    expect(uploaded.data.result.scanStatus).toBe('quarantined')
    expect(uploaded.data.result).toMatchObject({ rightsScope: 'limited_use', applicablePlatforms: ['taobao'], applicableRegions: ['CN', 'HK'], usageScopes: ['commercial', 'ai_generation'], aiModificationAllowed: false })
    const scanned = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'asset.scan', params: { asset_id: uploaded.data.result.id, scan_evidence_ref: 'scanner://mcp-test' } }) }).then(response => response.json()) as { data: { result: { scanStatus: string } } }
    expect(scanned.data.result.scanStatus).toBe('clean')
    const rights = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'asset.rights.update', params: { asset_id: uploaded.data.result.id, rights_status: 'approved', rights_scope: 'commercial_authorized', applicable_platforms_json: '["taobao","tmall"]', applicable_regions_json: '["CN"]', usage_scopes_json: '["platform_publish"]', ai_modification_allowed: 'false' } }) }).then(response => response.json()) as { data: { result: { rightsStatus: string; rightsScope: string; applicablePlatforms: string[]; applicableRegions: string[]; usageScopes: string[] } } }
    expect(rights.data.result).toMatchObject({ rightsStatus: 'approved', rightsScope: 'commercial_authorized', applicablePlatforms: ['taobao', 'tmall'], applicableRegions: ['CN'], usageScopes: ['platform_publish'] })
    const parsed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'asset.parse', params: { asset_id: uploaded.data.result.id } }) }).then(response => response.json()) as { data: { result: { parseStatus: string; extractedFacts: Record<string, string> } } }
    expect(parsed.data.result).toMatchObject({ parseStatus: 'succeeded', extractedFacts: { title: '轻量外套', material: '防晒面料' } })
    const unusable = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'asset.rights.update', params: { asset_id: uploaded.data.result.id, rights_status: 'approved', rights_scope: 'unusable' } }) }).then(response => response.json()) as { data: { result: { rightsScope: string } } }
    expect(unusable.data.result.rightsScope).toBe('unusable')
    const merchantStart = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'merchant.start', params: {} }) }).then(response => response.json()) as { data: { result: { summary: { readyAssets: number } } } }
    expect(merchantStart.data.result.summary.readyAssets).toBe(0)
  })

  it('rejects executable and signature-mismatched uploads before quarantine', async () => {
    const base = await start()
    const workspaceId = `ws_asset_gate_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-request-id': 'asset-security-request' }
    const executable = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'asset.upload', params: { name: 'logo.png', mime_type: 'image/png', content_base64: Buffer.from('MZ-not-an-image').toString('base64') } }) }).then(response => response.json()) as { error: { code: string } }
    expect(executable.error.code).toBe('ASSET_EXECUTABLE_REJECTED')
    const mismatch = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'asset.upload', params: { name: 'logo.png', mime_type: 'image/png', content_base64: Buffer.from('plain text').toString('base64') } }) }).then(response => response.json()) as { error: { code: string } }
    expect(mismatch.error.code).toBe('ASSET_EXTENSION_SIGNATURE_MISMATCH')
    const archive = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'asset.upload', params: { name: 'encrypted.zip', mime_type: 'application/zip', content_base64: Buffer.from('PK\x03\x04encrypted archive').toString('base64') } }) }).then(response => response.json()) as { error: { code: string } }
    expect(archive.error.code).toBe('ASSET_TYPE_UNSUPPORTED')
    const svgBody = '<svg xmlns="http://www.w3.org/2000/svg"><script>token-in-svg</script></svg>'
    const svg = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'asset.upload', params: { name: 'unsafe-customer-name.svg', mime_type: 'image/svg+xml', content_base64: Buffer.from(svgBody).toString('base64') } }) }).then(response => response.json()) as { error: { code: string } }
    expect(svg.error.code).toBe('ASSET_SVG_SCRIPT_REJECTED')

    const mixedBatch = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'asset.upload.batch', params: { assets_json: JSON.stringify([
      { name: 'batch-malware.png', mime_type: 'image/png', content_base64: Buffer.from('MZ-batch').toString('base64') },
      { name: 'safe-notes.txt', mime_type: 'text/plain', content_base64: Buffer.from('safe product notes').toString('base64') },
      { name: 'safe-data.json', mime_type: 'application/json', content_base64: Buffer.from('{"safe":true}').toString('base64') },
    ]) } }) }).then(response => response.json()) as { error: null; data: { result: { assets: Array<{ id: string; scanStatus: string }>; items: Array<{ index: number; status: string; error?: { code: string }; reason_codes?: string[]; security_audit_event_id?: string }>; succeeded: number; failed: number; counts: { total: number; succeeded: number; failed: number }; partial: boolean } } }
    expect(mixedBatch.error).toBeNull()
    expect(mixedBatch.data.result).toMatchObject({ succeeded: 2, failed: 1, counts: { total: 3, succeeded: 2, failed: 1 }, partial: true })
    expect(mixedBatch.data.result.assets).toHaveLength(2)
    expect(mixedBatch.data.result.assets.every(asset => asset.scanStatus === 'quarantined')).toBe(true)
    expect(mixedBatch.data.result.items).toEqual([
      expect.objectContaining({ index: 0, status: 'failed', error: expect.objectContaining({ code: 'ASSET_EXECUTABLE_REJECTED' }), reason_codes: expect.arrayContaining(['ASSET_EXECUTABLE_REJECTED']), security_audit_event_id: expect.stringMatching(/^asset_security_/u) }),
      expect.objectContaining({ index: 1, status: 'succeeded' }),
      expect.objectContaining({ index: 2, status: 'succeeded' }),
    ])

    const rejectedBatch = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'asset.upload.batch', params: { assets_json: JSON.stringify([
      { name: 'all-rejected-malware.png', mime_type: 'image/png', content_base64: Buffer.from('MZ-all-rejected').toString('base64') },
      { name: 'batch-unsafe.svg', mime_type: 'image/svg+xml', content_base64: Buffer.from(svgBody).toString('base64') },
    ]) } }) }).then(response => response.json()) as { error: null; data: { result: { assets: unknown[]; items: Array<{ status: string; reason_codes: string[]; security_audit_event_id: string }>; counts: { total: number; succeeded: number; failed: number }; partial: boolean } } }
    expect(rejectedBatch.error).toBeNull()
    expect(rejectedBatch.data.result).toMatchObject({ assets: [], counts: { total: 2, succeeded: 0, failed: 2 }, partial: false })
    expect(rejectedBatch.data.result.items).toEqual([
      expect.objectContaining({ status: 'failed', reason_codes: expect.arrayContaining(['ASSET_EXECUTABLE_REJECTED']), security_audit_event_id: expect.stringMatching(/^asset_security_/u) }),
      expect.objectContaining({ status: 'failed', reason_codes: expect.arrayContaining(['ASSET_SVG_SCRIPT_REJECTED']), security_audit_event_id: expect.stringMatching(/^asset_security_/u) }),
    ])

    const restSvg = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'content-type': 'image/svg+xml', 'x-workspace-id': workspaceId, 'x-request-id': 'asset-security-rest-request', 'x-asset-name': encodeURIComponent('rest-private-name.svg') }, body: svgBody }).then(response => response.json()) as { error: { code: string } }
    expect(restSvg.error.code).toBe('ASSET_SVG_SCRIPT_REJECTED')

    const audits = securityAuditEventsForTests(workspaceId)
    expect(audits).toHaveLength(8)
    expect(audits.map(event => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'reject', reason_code: 'ASSET_EXECUTABLE_REJECTED', request_id: 'asset-security-request', file_name_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      expect.objectContaining({ decision: 'reject', reason_code: 'ASSET_SVG_SCRIPT_REJECTED' }),
      expect.objectContaining({ decision: 'reject', reason_code: 'ASSET_SVG_SCRIPT_REJECTED', request_id: 'asset-security-rest-request' }),
      expect.objectContaining({ decision: 'reject', batch_index: 0 }),
      expect.objectContaining({ decision: 'reject', batch_index: 1 }),
    ]))
    expect(JSON.stringify(audits)).not.toMatch(/unsafe-customer-name|batch-malware|all-rejected-malware|batch-unsafe|rest-private-name|token-in-svg|content_base64/u)
  })

})
