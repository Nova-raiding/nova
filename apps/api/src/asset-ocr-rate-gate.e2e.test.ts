import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { MemoryAssetParseRepository } from '../../../packages/persistence/src/asset-parse-repository.js'

let api: typeof import('./server.js')
let base: string
let relayHandler: (url: string) => Promise<Response> = async url => { throw new Error(`unexpected relay request: ${url}`) }

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('DEPLOYMENT_PROFILE', 'local_acceptance')
  vi.stubEnv('LOCAL_COMPOSE', 'true')
  vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'true')
  vi.stubEnv('MODEL_RELAY_BASE_URL', 'https://relay.example.test/v1')
  vi.stubEnv('MODEL_RELAY_API_KEY', 'ocr-rate-gate-test-key')
  vi.stubEnv('OCR_MODEL', 'vision-rate-gate-test')
  vi.stubEnv('AI_MODEL', 'text-rate-gate-test')
  vi.stubEnv('MODEL_MAX_TASK_COST_CNY', '2')
  vi.stubEnv('MODEL_DAILY_CNY_LIMIT', '20')
  const originalFetch = globalThis.fetch.bind(globalThis)
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    return url.startsWith('https://relay.example.test/') ? relayHandler(url) : originalFetch(input, init)
  })
  api = await import('./server.js')
  await new Promise<void>((resolve, reject) => {
    api.server.once('error', reject)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', reject); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (api.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
})

afterEach(() => { api?.setApprovedOcrRateForTests(); api?.setOcrPreDispatchFailureForTests(); api?.setOcrParseDeadlineForTests(); api?.setAssetParseRuntimeForTests() })

const approvedOcrRate = { rateCardId: 'ocr-test-approved', version: 1, actionCode: 'ocr.extract' as const,
  unit: 'request' as const, pricingMode: 'variable' as const, variableFormula: { kind: 'cost_cny_x2_ceil_min1' as const },
  checksum: 'a'.repeat(64), effectiveAt: '2026-09-25T00:00:00.000Z' }

const approvedThresholdOcrRate = { ...approvedOcrRate, rateCardId: 'ocr-test-threshold-approved', version: 4,
  variableFormula: { kind: 'cost_cny_threshold_x2_ceil_v1' as const, free_when_cost_cny_lte: 0.3 as const,
    multiplier: 2 as const, min_paid_points: 1 as const }, checksum: 'b'.repeat(64) }

async function uploadOcrImage(workspaceId: string) {
  const response = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'x-workspace-id': workspaceId, 'content-type': 'image/png', 'x-asset-name': 'label.png' }, body: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') as BodyInit })
  expect(response.status).toBe(201)
  return (await response.json() as { data: { id: string } }).data.id
}

it('keeps a v4 OCR hold and blocks replay when receipt settlement is unavailable', async () => {
  api.setApprovedOcrRateForTests(approvedThresholdOcrRate)
  const workspaceId = `ws_ocr_threshold_receipt_${Date.now()}`
  await api.grantCreativePointsForTests(workspaceId, 5)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  const imageId = await uploadOcrImage(workspaceId)
  const actionKey = `asset-parse:${imageId}:attempt:1`
  let relayRequests = 0
  relayHandler = async () => {
    relayRequests += 1
    expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, actionKey)).toMatchObject({ status: 'active', points: 4 })
    expect((await api.creativePointsForTests.getBalance(workspaceId)).availablePoints).toBe(1)
    return new Response(JSON.stringify({
      id: 'ocr-threshold-receipt',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost_cny: 0.3 },
      choices: [{ message: { content: JSON.stringify({ facts: { product_name: '费率边界测试商品' }, ocr_text: '费率边界测试商品' }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'ocr-threshold-receipt' } })
  }
  const endpoint = `${base}/v1/assets/${imageId}/parse`
  const response = await fetch(endpoint, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: { code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', details: { retryable: false } } })
  expect(relayRequests).toBe(1)
  expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, actionKey)).toMatchObject({ status: 'active', points: 4, settledPoints: null })
  expect((await api.creativePointsForTests.getBalance(workspaceId)).availablePoints).toBe(1)
  const replay = await fetch(endpoint, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(replay.status).toBe(409)
  expect(await replay.json()).toMatchObject({ error: { code: 'OCR_PREVIOUS_ATTEMPT_RECONCILIATION_REQUIRED' } })
  expect(relayRequests).toBe(1)
  expect((await api.creativePointsForTests.getBalance(workspaceId)).availablePoints).toBe(1)
})

it('requires the full OCR hold, then lets the same asset resume after recharge', async () => {
  api.setApprovedOcrRateForTests(approvedOcrRate)
  const workspaceId = `ws_ocr_insufficient_${Date.now()}`
  await api.grantCreativePointsForTests(workspaceId, 3)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  const imageId = await uploadOcrImage(workspaceId)
  let requests = 0
  relayHandler = async () => { requests += 1; throw new Error('unfunded OCR reached relay') }
  const response = await fetch(`${base}/v1/assets/${imageId}/parse`, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(response.status).toBe(402)
  expect(await response.json()).toMatchObject({ error: { code: 'CREATIVE_POINT_INSUFFICIENT', details: { retryable: true } } })
  expect(requests).toBe(0)
  expect((await api.creativePointsForTests.getBalance(workspaceId)).availablePoints).toBe(3)
  await api.creativePointsForTests.grant({ workspaceId, idempotencyKey: `ocr-topup:${workspaceId}`, sourceType: 'test_fixture', sourceId: `ocr-topup:${workspaceId}`, points: 2, metadata: { test_only: true } })
  relayHandler = async () => { requests += 1; return new Response(JSON.stringify({ error: { message: 'definitive rejection' } }), { status: 400, headers: { 'content-type': 'application/json' } }) }
  const resumed = await fetch(`${base}/v1/assets/${imageId}/parse`, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(resumed.status).toBeGreaterThanOrEqual(400)
  expect(requests).toBe(1)
  expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, `asset-parse:${imageId}:attempt:2`)).toMatchObject({ status: 'released', points: 4 })
})

it('holds four points during OCR and releases only after a definitive provider rejection', async () => {
  api.setApprovedOcrRateForTests(approvedOcrRate)
  const workspaceId = `ws_ocr_known_failure_${Date.now()}`
  await api.grantCreativePointsForTests(workspaceId, 5)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  const imageId = await uploadOcrImage(workspaceId)
  const actionKey = `asset-parse:${imageId}:attempt:1`
  relayHandler = async () => {
    const reservation = await api.creativePointsForTests.getReservationByActionKey(workspaceId, actionKey)
    expect(reservation).toMatchObject({ status: 'active', points: 4 })
    return new Response(JSON.stringify({ error: { message: 'definitive rejection' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  const response = await fetch(`${base}/v1/assets/${imageId}/parse`, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, actionKey)).toMatchObject({ status: 'released', points: 4 })
})

it('releases OCR points when a deterministic pre-dispatch budget check fails', async () => {
  api.setApprovedOcrRateForTests(approvedOcrRate)
  api.setOcrPreDispatchFailureForTests(() => { throw Object.assign(new Error('budget unavailable'), { code: 'MODEL_COST_BUDGET_PREFLIGHT_UNAVAILABLE' }) })
  const workspaceId = `ws_ocr_budget_preflight_${Date.now()}`
  await api.grantCreativePointsForTests(workspaceId, 5)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  const imageId = await uploadOcrImage(workspaceId)
  let requests = 0
  relayHandler = async () => { requests += 1; throw new Error('pre-dispatch failure reached relay') }
  const response = await fetch(`${base}/v1/assets/${imageId}/parse`, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, `asset-parse:${imageId}:attempt:1`)).toMatchObject({ status: 'released', points: 4 })
  expect(await api.actionLedgerForTests.get(workspaceId, `asset-parse:${imageId}:attempt:1`)).toMatchObject({ settlementStatus: 'released' })
  expect((await api.creativePointsForTests.getBalance(workspaceId)).availablePoints).toBe(5)
  expect(requests).toBe(0)
})

it('retains the OCR hold and stops automatic retry when the provider outcome is unknown', async () => {
  api.setApprovedOcrRateForTests(approvedOcrRate)
  const workspaceId = `ws_ocr_unknown_${Date.now()}`
  await api.grantCreativePointsForTests(workspaceId, 5)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  const imageId = await uploadOcrImage(workspaceId)
  let requests = 0
  relayHandler = async () => { requests += 1; throw new TypeError('response lost') }
  const endpoint = `${base}/v1/assets/${imageId}/parse`
  const response = await fetch(endpoint, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: { code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', details: { retryable: false } } })
  expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, `asset-parse:${imageId}:attempt:1`)).toMatchObject({ status: 'active', points: 4 })
  await fetch(endpoint, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(requests).toBe(1)
})

it('never sends a second OCR request after the parse deadline expires', async () => {
  api.setApprovedOcrRateForTests(approvedOcrRate)
  api.setOcrParseDeadlineForTests(25)
  const workspaceId = `ws_ocr_deadline_${Date.now()}`
  await api.grantCreativePointsForTests(workspaceId, 5)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  const imageId = await uploadOcrImage(workspaceId)
  let requests = 0
  relayHandler = async () => {
    requests += 1
    await new Promise(resolve => setTimeout(resolve, 100))
    throw new TypeError('late provider response lost')
  }
  const endpoint = `${base}/v1/assets/${imageId}/parse`
  const first = await fetch(endpoint, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(first.status).toBe(504)
  const second = await fetch(endpoint, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(second.status).toBe(409)
  expect(requests).toBe(1)
  expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, `asset-parse:${imageId}:attempt:1`)).toMatchObject({ status: 'active', points: 4 })
})

it.each(['active', 'settled'] as const)('blocks a retryable prior parse after restart when its OCR point hold is %s', async reservationStatus => {
  api.setApprovedOcrRateForTests(approvedOcrRate)
  const workspaceId = `ws_ocr_durable_guard_${Date.now()}`
  await api.grantCreativePointsForTests(workspaceId, 5)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  const imageId = await uploadOcrImage(workspaceId)
  const repository = new MemoryAssetParseRepository()
  const lease = await repository.claim({ workspaceId, assetId: imageId, leaseMs: 10_000, maxAttempts: 3 })
  await repository.fail({ workspaceId, assetId: imageId, leaseToken: lease.leaseToken, errorCode: 'ASSET_PARSE_TIMEOUT', errorMessage: 'old process expired', retryable: true })
  api.setAssetParseRuntimeForTests({ repository })
  const actionKey = `asset-parse:${imageId}:attempt:1`
  const held = await api.creativePointsForTests.reserve({ workspaceId, actionKey, idempotencyKey: `commercial.reserve:${actionKey}`, points: 4, rateCardVersion: 'ocr.cost_cny_x2_ceil_min1.v1:test' })
  if (reservationStatus === 'settled') await api.creativePointsForTests.settle({ workspaceId, reservationId: held.value.id, idempotencyKey: `commercial.settle:${actionKey}`, actualPoints: 1, at: new Date().toISOString() })
  let requests = 0
  relayHandler = async () => { requests += 1; throw new Error('durable guard failed') }
  const response = await fetch(`${base}/v1/assets/${imageId}/parse`, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'OCR_PREVIOUS_ATTEMPT_RECONCILIATION_REQUIRED', details: { reconciliation_required: true, reservation_status: reservationStatus } } })
  expect(requests).toBe(0)
  expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, actionKey)).toMatchObject({ status: reservationStatus, points: 4 })
})

it('blocks unpriced OCR before relay dispatch while leaving local document parsing available', async () => {
  const workspaceId = `ws_ocr_rate_${Date.now()}`
  await api.grantCreativePointsForTests(workspaceId)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  const relayRequests: string[] = []
  relayHandler = async url => { relayRequests.push(url); throw new Error('unpriced OCR reached relay') }
  const upload = async (name: string, mime: string, body: Buffer | string) => {
    const response = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'x-workspace-id': workspaceId, 'content-type': mime, 'x-asset-name': name }, body: body as BodyInit })
    expect(response.status).toBe(201)
    return (await response.json() as { data: { id: string } }).data.id
  }
  const imageId = await upload('label.png', 'image/png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  const deniedResponse = await fetch(`${base}/v1/assets/${imageId}/parse`, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  const denied = await deniedResponse.json() as { error: { code: string; details: { retryable: boolean; next_actions: string[] } } }
  expect(deniedResponse.status).toBe(503)
  expect(denied.error).toMatchObject({ code: 'OCR_CREATIVE_POINT_RATE_UNAVAILABLE', details: { retryable: true, next_actions: ['asset.parse', 'asset.facts.confirm'] } })
  expect(relayRequests).toEqual([])

  const textId = await upload('facts.txt', 'text/plain', 'title: 本地解析\nstock: 8')
  const parsedResponse = await fetch(`${base}/v1/assets/${textId}/parse`, { method: 'POST', headers: { 'x-workspace-id': workspaceId } })
  expect(parsedResponse.status).toBe(200)
  expect(await parsedResponse.json()).toMatchObject({ data: { extractedFactsSource: 'parser', extractedFacts: { title: '本地解析', stock: '8' } } })
  expect(relayRequests).toEqual([])
})

it.each(['content.draft.generate', 'merchant.first_value'] as const)('denies %s before relay at zero available points', async method => {
  const workspaceId = `ws_draft_rate_${method.replaceAll('.', '_')}_${Date.now()}`
  await api.grantCreativePointsForTests(workspaceId, 1)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  await api.creativePointsForTests.reserve({ workspaceId, actionKey: `test-hold:${workspaceId}`, idempotencyKey: `test-hold:${workspaceId}`, points: 1, rateCardVersion: 'test-rate-v1' })
  const relayRequests: string[] = []
  relayHandler = async url => { relayRequests.push(url); throw new Error('unfunded draft reached relay') }
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'x-workspace-id': workspaceId, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { draft: 'true', draft_title: '未绑定商品候选', idempotency_key: 'draft-zero-balance' } }),
  })
  const body = await response.json() as { error: { code: string; details: { quoted_points: number; available_points: number; classification: string } } }
  expect(response.status).toBe(402)
  expect(body.error).toMatchObject({ code: 'CREATIVE_POINTS_EXHAUSTED', details: { available_points: 0, classification: 'POINT_CHARGED' } })
  expect(relayRequests).toEqual([])
})

it('reserves the approved one-point text rate under the relay action id before draft dispatch', async () => {
  const workspaceId = `ws_draft_reserved_${Date.now()}`
  const idempotencyKey = 'draft-reserved-test'
  const actionId = `content-draft:${createHash('sha256').update(`${workspaceId}:${idempotencyKey}`).digest('hex')}`
  await api.grantCreativePointsForTests(workspaceId, 2)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  const observed: Array<{ status: string; points: number; available: number }> = []
  relayHandler = async () => {
    const reservation = await api.creativePointsForTests.getReservationByActionKey(workspaceId, actionId)
    const balance = await api.creativePointsForTests.getBalance(workspaceId)
    observed.push({ status: reservation?.status ?? 'missing', points: reservation?.points ?? -1, available: balance.availablePoints ?? -1 })
    return new Response(JSON.stringify({ error: { message: 'test provider rejection' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'x-workspace-id': workspaceId, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'content.draft.generate', params: { draft: 'true', draft_title: '未绑定商品候选', idempotency_key: idempotencyKey } }),
  })
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(observed).toEqual([{ status: 'active', points: 1, available: 1 }])
  expect(await response.json()).toMatchObject({ error: { code: 'MODEL_PROVIDER_REQUEST_FAILED' } })
  expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, actionId)).toMatchObject({ status: 'released', points: 1 })
})

it('retains the point reservation when draft provider outcome is unknown', async () => {
  const workspaceId = `ws_draft_unknown_${Date.now()}`
  const idempotencyKey = 'draft-unknown-test'
  const actionId = `content-draft:${createHash('sha256').update(`${workspaceId}:${idempotencyKey}`).digest('hex')}`
  await api.grantCreativePointsForTests(workspaceId, 2)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  let attempts = 0
  relayHandler = async () => { attempts += 1; throw new TypeError('test transport response lost') }
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'x-workspace-id': workspaceId, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'content.draft.generate', params: { draft: 'true', draft_title: '未绑定商品候选', idempotency_key: idempotencyKey } }),
  })
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(await response.json()).toMatchObject({ error: { code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' } })
  expect(attempts).toBe(1)
  expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, actionId)).toMatchObject({ status: 'active', points: 1 })
})
