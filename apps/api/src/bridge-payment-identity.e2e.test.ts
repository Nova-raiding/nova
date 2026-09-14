import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { signPaymentCallback } from '../../../packages/billing/src/callback-envelope.mjs'

type Envelope<T = unknown> = {
  data: T | null
  error: { code: string; message?: string } | null
}

type ApiModule = typeof import('./server.js')

const BRIDGE_PATH = fileURLToPath(new URL('../../plugin/mcp/bridge.mjs', import.meta.url))
const CALLBACK_SECRET = 'bridge-payment-e2e-callback-secret'

let api: ApiModule

function nextLine(stream: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onError = (error: Error) => {
      stream.off('data', onData)
      reject(error)
    }
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      stream.off('data', onData)
      stream.off('error', onError)
      resolve(JSON.parse(buffer.slice(0, newline)))
    }
    stream.on('data', onData)
    stream.once('error', onError)
  })
}

async function callBridge(child: ChildProcessWithoutNullStreams, id: number, name: string, arguments_: Record<string, unknown>) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } })}\n`)
  const response = await nextLine(child.stdout)
  expect(response.error, JSON.stringify(response)).toBeUndefined()
  expect(response.result?.isError, JSON.stringify(response)).toBe(false)
  return response.result.structuredContent as Record<string, any>
}

async function startApi() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    api.server.once('error', onError)
    api.server.listen(0, '127.0.0.1', () => {
      api.server.removeListener('error', onError)
      resolve()
    })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('API server did not bind')
  return `http://127.0.0.1:${address.port}`
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
  vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
  vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
  vi.stubEnv('PAYMENT_MODE', 'fixture')
  vi.stubEnv('PAYMENT_CALLBACK_SECRET', CALLBACK_SECRET)
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'bridge-payment-identity-session-secret')
  api = await import('./server.js')
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('ChatGPT bridge payment identity vertical slice', () => {
  it('creates and reads one paid order as the same authenticated actor after a signed callback', async () => {
    const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const workspaceId = `ws_bridge_payment_${suffix}`
    const actorId = `merchant-bridge-${suffix}`
    const token = `bridge-payment-token-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['operator'] },
    }))
    await api.workspaceMembers.upsert({
      workspaceId,
      externalSubject: actorId,
      displayName: 'Bridge payment identity E2E',
      role: 'operator',
      status: 'active',
      invitedBy: 'bridge-payment-e2e',
    })
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)

    const base = await startApi()
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOY_ENV: 'test',
        MERCHANT_MCP_BASE_URL: base,
        MERCHANT_WORKSPACE_ID: workspaceId,
        MERCHANT_MCP_TOKEN: token,
        MERCHANT_STRICT_AUTH: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    try {
      await callBridge(child, 1, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' })
      const order = await callBridge(child, 2, 'billing.recharge.create', {
        channel: 'alipay',
        amount_cny: '10.00',
        idempotency_key: `bridge-payment-${suffix}`,
      })
      expect(order).toMatchObject({
        state: 'pending',
        amount_cny: '10.00',
      })
      expect(order.id).toEqual(expect.stringMatching(/^recharge_/u))
      expect(order.paymentUrl ?? order.payment_url).toEqual(expect.stringMatching(/^fixture:\/\/alipay\//u))

      const callback = {
        workspace_id: workspaceId,
        order_id: order.id,
        provider_trade_id: `alipay-fixture-${suffix}`,
        amount_fen: 1000,
        currency: 'CNY' as const,
        state: 'paid' as const,
      }
      const timestamp = String(Math.floor(Date.now() / 1000))
      const nonce = `bridge-payment-${randomUUID().replaceAll('-', '')}`
      // This is the exact server-to-server envelope emitted by the checked-in
      // payment gateway after it has verified Alipay's native RSA2 callback.
      const signature = signPaymentCallback({
        secret: CALLBACK_SECRET,
        channel: 'alipay',
        workspaceId,
        orderId: order.id,
        providerTradeId: callback.provider_trade_id,
        amountFen: callback.amount_fen,
        currency: callback.currency,
        state: callback.state,
        timestamp,
        nonce,
      })
      const callbackHeaders = {
        'content-type': 'application/json',
        'x-payment-signature': signature,
        'x-payment-timestamp': timestamp,
        'x-payment-nonce': nonce,
      }
      const firstCallback = await fetch(`${base}/v1/billing/callback/alipay`, {
        method: 'POST',
        headers: callbackHeaders,
        body: JSON.stringify(callback),
      }).then(response => response.json() as Promise<Envelope<{ state: string }>>)
      expect(firstCallback.error).toBeNull()
      expect(firstCallback.data).toMatchObject({ state: 'paid' })

      // Provider retry must remain idempotent even though the signed nonce was
      // already consumed by the first delivery.
      const replay = await fetch(`${base}/v1/billing/callback/alipay`, {
        method: 'POST',
        headers: callbackHeaders,
        body: JSON.stringify(callback),
      }).then(response => response.json() as Promise<Envelope<{ state: string }>>)
      expect(replay.error).toBeNull()
      expect(replay.data).toMatchObject({ state: 'paid' })

      const paid = await callBridge(child, 3, 'billing.recharge.get', { order_id: order.id })
      expect(paid).toMatchObject({
        id: order.id,
        state: 'paid',
      })
      expect(paid).not.toHaveProperty('providerTradeId')
      expect(paid).not.toHaveProperty('createdByActorId')

      const transactions = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-ops-workbench': 'workspace',
          'x-workspace-id': workspaceId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'billing.transactions',
          params: { workspace_id: workspaceId, scope: 'mine', limit: '20' },
        }),
      }).then(response => response.json() as Promise<Envelope<{ result: { transactions: Array<Record<string, unknown>> } }>>)
      expect(transactions.error).toBeNull()
      expect(transactions.data?.result.transactions.filter(transaction => transaction.orderId === order.id)).toEqual([
        expect.objectContaining({ type: 'recharge', amount_cny: '10.00', actorId }),
      ])
    } finally {
      child.kill()
    }
  })
})
