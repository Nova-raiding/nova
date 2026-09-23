import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

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
  expect(denied.error).toMatchObject({ code: 'OCR_CREATIVE_POINT_RATE_UNAVAILABLE', details: { retryable: false, next_actions: ['asset.facts.confirm'] } })
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
