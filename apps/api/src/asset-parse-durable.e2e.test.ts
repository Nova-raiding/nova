import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAssetParseRepository } from '../../../packages/persistence/src/asset-parse-repository.js'

let api: typeof import('./server.js')

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

async function cleanImage(base: string, workspaceId: string, suffix: string) {
  const body = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(suffix)])
  const response = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'x-workspace-id': workspaceId, 'content-type': 'image/png', 'x-asset-name': `${suffix}.png` }, body })
  const uploaded = await response.json() as { data: { id: string; scanStatus: string; scanAutomation: { state: string; mode: string; userActionRequired: boolean; productionEvidence: boolean } } }
  expect(response.status).toBe(201)
  expect(uploaded.data).toMatchObject({
    scanStatus: 'clean',
    scanAutomation: { state: 'completed', mode: 'local_fixture', userActionRequired: false, productionEvidence: false },
  })
  return uploaded.data.id
}

async function mcp(base: string, workspaceId: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'asset-reviewer' }, body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params }) })
  return { status: response.status, body: await response.json() as any }
}

async function confirmFacts(base: string, workspaceId: string, assetId: string, endpoint: 'mcp' | 'rest') {
  if (endpoint === 'mcp') return mcp(base, workspaceId, 'asset.facts.confirm', { asset_id: assetId, facts_json: JSON.stringify({ title: 'merchant fact' }), reason: '商家核对包装后人工确认' })
  const response = await fetch(`${base}/v1/assets/${assetId}/facts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'asset-reviewer' }, body: JSON.stringify({ facts: { title: 'merchant fact' }, reason: '商家核对包装后人工确认' }) })
  return { status: response.status, body: await response.json() as any }
}

describe('durable asset parse API wiring', () => {
  beforeAll(async () => { api = await import('./server.js') })
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('DEPLOYMENT_PROFILE', 'local_acceptance')
    vi.stubEnv('LOCAL_COMPOSE', 'true')
    vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'true')
    api.setAssetParseRuntimeForTests()
  })
  afterEach(async () => {
    api.setAssetParseRuntimeForTests()
    vi.unstubAllEnvs()
    if (api.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  })

  it('admits only one parser, returns BUSY with retry guidance, and replays durable facts without parser or duplicate debit', async () => {
    const base = await start()
    const workspaceId = `ws_parse_concurrent_${Date.now()}`
    const assetId = await cleanImage(base, workspaceId, 'concurrent')
    const repository = new MemoryAssetParseRepository()
    let release!: (value: { facts: Record<string, unknown>; source: 'model_ocr' }) => void
    let started!: () => void
    const parserStarted = new Promise<void>(resolve => { started = resolve })
    const parserResult = new Promise<{ facts: Record<string, unknown>; source: 'model_ocr' }>(resolve => { release = resolve })
    const parse = vi.fn(async () => { started(); return parserResult })
    api.setAssetParseRuntimeForTests({ repository, parse })

    const firstPromise = mcp(base, workspaceId, 'asset.parse', { asset_id: assetId })
    await parserStarted
    expect(api.service.assets.get(assetId)).toMatchObject({ parseStatus: 'processing' })
    const busy = await mcp(base, workspaceId, 'asset.parse', { asset_id: assetId })
    expect(busy).toMatchObject({ status: 409, body: { error: { code: 'ASSET_PARSE_BUSY', details: { retry_after_seconds: expect.any(Number) } } } })
    release({ facts: { title: 'durable OCR fact' }, source: 'model_ocr' })
    const first = await firstPromise
    expect(first).toMatchObject({ status: 200, body: { data: { result: { parseStatus: 'succeeded', extractedFacts: { title: 'durable OCR fact' }, execution: { replayed: false, attempts: 1 } } } } })
    const billingAfterFirst = await mcp(base, workspaceId, 'billing.transactions', {})
    const transactionsAfterFirst = billingAfterFirst.body.data.result.transactions

    const asset = api.service.assets.get(assetId)!
    asset.parseStatus = 'pending'; asset.extractedFacts = undefined; asset.extractedFactsSource = undefined
    api.setAssetParseRuntimeForTests({ repository, parse: vi.fn(async () => { throw new Error('parser must not run during replay') }) })
    const replay = await mcp(base, workspaceId, 'asset.parse', { asset_id: assetId })
    expect(replay).toMatchObject({ status: 200, body: { data: { result: { parseStatus: 'succeeded', extractedFacts: { title: 'durable OCR fact' }, execution: { replayed: true, attempts: 1 } } } } })
    expect(parse).toHaveBeenCalledTimes(1)

    const billingAfterReplay = await mcp(base, workspaceId, 'billing.transactions', {})
    expect(billingAfterReplay.body.data.result.transactions).toEqual(transactionsAfterFirst)
  })

  it('records timeout and empty outcomes durably, then allows bounded recovery', async () => {
    const base = await start()
    const workspaceId = `ws_parse_recovery_${Date.now()}`
    const repository = new MemoryAssetParseRepository()
    vi.stubEnv('ASSET_PARSE_TIMEOUT_MS', '20')
    vi.stubEnv('ASSET_PARSE_MAX_ATTEMPTS', '3')

    const timeoutAssetId = await cleanImage(base, workspaceId, 'timeout')
    api.setAssetParseRuntimeForTests({ repository, parse: async () => await new Promise(() => undefined) })
    const timedOut = await mcp(base, workspaceId, 'asset.parse', { asset_id: timeoutAssetId })
    expect(timedOut).toMatchObject({ status: 504, body: { error: { code: 'ASSET_PARSE_TIMEOUT', details: { retryable: true, attempts: 1 } } } })
    await expect(repository.get({ workspaceId, assetId: timeoutAssetId })).resolves.toMatchObject({ state: 'failed', errorCode: 'ASSET_PARSE_TIMEOUT', retryable: true })
    expect(api.service.assets.get(timeoutAssetId)).toMatchObject({ parseStatus: 'failed', storageKey: expect.stringMatching(/^clean\//u) })

    // The 20 ms deadline belongs only to the timeout scenario. Leaving this
    // process-wide stub active makes the recovery and empty-result scenarios
    // race storage/billing setup and misreport a fresh result as another timeout.
    vi.stubEnv('ASSET_PARSE_TIMEOUT_MS', '30000')
    vi.stubEnv('ASSET_PARSE_MAX_ATTEMPTS', '3')
    api.setAssetParseRuntimeForTests({ repository, parse: async () => ({ facts: { recovered: true }, source: 'model_ocr' }) })
    const recovered = await mcp(base, workspaceId, 'asset.parse', { asset_id: timeoutAssetId })
    expect(recovered.body.error).toBeNull()
    expect(recovered).toMatchObject({ status: 200, body: { data: { result: { extractedFacts: { recovered: true }, execution: { attempts: 2 } } } } })

    const emptyAssetId = await cleanImage(base, workspaceId, 'empty')
    vi.stubEnv('ASSET_PARSE_MAX_ATTEMPTS', '2')
    api.setAssetParseRuntimeForTests({ repository, parse: async () => ({ facts: {}, source: 'model_ocr' }) })
    const empty = await mcp(base, workspaceId, 'asset.parse', { asset_id: emptyAssetId })
    expect(empty).toMatchObject({ status: 422, body: { error: { code: 'ASSET_PARSE_EMPTY', details: { retryable: true, attempts: 1 } } } })
    await expect(repository.get({ workspaceId, assetId: emptyAssetId })).resolves.toMatchObject({ state: 'failed', errorCode: 'ASSET_PARSE_EMPTY' })
    const emptyRetry = await mcp(base, workspaceId, 'asset.parse', { asset_id: emptyAssetId })
    expect(emptyRetry).toMatchObject({ status: 422, body: { error: { code: 'ASSET_PARSE_EMPTY', details: { attempts: 2 } } } })
    const exhausted = await mcp(base, workspaceId, 'asset.parse', { asset_id: emptyAssetId })
    expect(exhausted).toMatchObject({ status: 409, body: { error: { code: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED' } } })
  })

  it.each([
    ['mcp', 'succeed'], ['mcp', 'fail'], ['mcp', 'timeout'],
    ['rest', 'succeed'], ['rest', 'fail'], ['rest', 'timeout'],
  ] as const)('lets %s manual confirmation defeat an old parser %s outcome', async (endpoint, outcome) => {
    const base = await start()
    const workspaceId = `ws_parse_manual_race_${endpoint}_${outcome}_${Date.now()}`
    const assetId = await cleanImage(base, workspaceId, `manual-race-${endpoint}-${outcome}`)
    const repository = new MemoryAssetParseRepository()
    let release!: () => void
    let started!: () => void
    const parserStarted = new Promise<void>(resolve => { started = resolve })
    const parserRelease = new Promise<void>(resolve => { release = resolve })
    if (outcome === 'timeout') vi.stubEnv('ASSET_PARSE_TIMEOUT_MS', '1000')
    api.setAssetParseRuntimeForTests({ repository, parse: async () => {
      started()
      if (outcome === 'timeout') return await new Promise(() => undefined)
      await parserRelease
      if (outcome === 'fail') throw new Error('late parser failure')
      return { facts: { title: 'stale parser fact' }, source: 'model_ocr' }
    } })

    const automaticPromise = mcp(base, workspaceId, 'asset.parse', { asset_id: assetId })
    await parserStarted
    const manual = await confirmFacts(base, workspaceId, assetId, endpoint)
    expect(manual.status).toBe(200)
    const confirmed = endpoint === 'mcp' ? manual.body.data.result : manual.body.data
    expect(confirmed).toMatchObject({ extractedFactsSource: 'manual', extractedFacts: { title: 'merchant fact' } })
    if (outcome !== 'timeout') release()
    const stale = await automaticPromise
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'ASSET_PARSE_STALE_RESULT' } } })
    expect(api.service.assets.get(assetId)).toMatchObject({ parseStatus: 'succeeded', extractedFactsSource: 'manual', extractedFacts: { title: 'merchant fact' }, storageKey: expect.stringMatching(/^clean\//u) })
    await expect(repository.get({ workspaceId, assetId })).resolves.toMatchObject({ state: 'succeeded', facts: { title: 'merchant fact' } })
  })

  it.each(['mcp', 'rest'] as const)('does not mutate service when %s durable confirmation fails', async endpoint => {
    const base = await start()
    const workspaceId = `ws_parse_confirm_failure_${endpoint}_${Date.now()}`
    const assetId = await cleanImage(base, workspaceId, `confirm-failure-${endpoint}`)
    const backing = new MemoryAssetParseRepository()
    const repository = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === 'confirm') return async () => { throw new Error('durable confirm unavailable') }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    api.setAssetParseRuntimeForTests({ repository })
    const before = structuredClone(api.service.assets.get(assetId)!)
    const failed = await confirmFacts(base, workspaceId, assetId, endpoint)
    expect(failed.status).toBe(500)
    expect(api.service.assets.get(assetId)).toEqual(before)
    await expect(backing.get({ workspaceId, assetId })).resolves.toBeUndefined()
  })
})
