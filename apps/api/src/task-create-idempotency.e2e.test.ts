import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from './server.js'

type Envelope<T = unknown> = { data: T | null; error: { code: string; message: string } | null }

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('REST task creation idempotency', () => {
  beforeEach(() => { vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000') })
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('replays one task for one intent and rejects key reuse with different input', async () => {
    const base = await start()
    const idempotencyKey = `merchant-route-${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }
    const create = (body: Record<string, unknown>) => fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: 'prod_fixture_1', platform: 'taobao', idempotency_key: idempotencyKey, ...body }) })

    const firstResponse = await create({})
    const first = await firstResponse.json() as Envelope<{ id: string }>
    expect(firstResponse.status).toBe(201)
    expect(first.error).toBeNull()

    const replayResponse = await create({})
    const replay = await replayResponse.json() as Envelope<{ id: string }>
    expect(replayResponse.status).toBe(200)
    expect(replay.data?.id).toBe(first.data?.id)

    const conflictResponse = await create({ request_text: '不同的任务创建意图' })
    const conflict = await conflictResponse.json() as Envelope
    expect(conflictResponse.status).toBe(409)
    expect(conflict.error?.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('rejects an oversized idempotency key before creating a task', async () => {
    const base = await start()
    const response = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ product_id: 'prod_fixture_1', platform: 'taobao', idempotency_key: 'x'.repeat(201) }) })
    const body = await response.json() as Envelope
    expect(response.status).toBe(400)
    expect(body.error?.code).toBe('IDEMPOTENCY_KEY_INVALID')
  })
})
