import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyPaymentCallbackSignature } from '../packages/billing/src/payment-provider.js'
import { encodeAlipayParams, encodePassbackParams, signingContent } from '../services/payment-gateway/alipay.mjs'

type RecordedRequest = {
  body: Record<string, unknown>
  headers: Record<string, string | string[] | undefined>
  path: string
}

const children = new Set<ChildProcessWithoutNullStreams>()
const servers = new Set<Server>()

async function listen(server: Server) {
  servers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return address.port
}

async function reservePort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  servers.delete(server)
  return port
}

async function waitForGateway(base: string, child: ChildProcessWithoutNullStreams, logs: () => string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`payment gateway exited before readiness (${child.exitCode}): ${logs()}`)
    try {
      const response = await fetch(`${base}/healthz`)
      if (response.ok) return
    } catch {
      // The child may still be binding its socket.
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`payment gateway readiness timeout: ${logs()}`)
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  children.delete(child)
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 2_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild))
  await Promise.all([...servers].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  servers.clear()
})

describe('payment gateway process contract', () => {
  it('fails closed for non-Alipay query/refund and forwards a verified Alipay notification with a currency-bound signature', async () => {
    const alipayKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const merchantKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const alipayPrivateKey = alipayKeyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const alipayPublicKey = alipayKeyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const merchantPrivateKey = merchantKeyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const callbackSecret = 'process-contract-callback-secret'
    const gatewayApiKey = 'process-contract-gateway-key'
    const appId = 'process-contract-alipay-app'
    let alipayCalls = 0
    const alipayPort = await listen(createServer((_req, res) => {
      alipayCalls += 1
      res.writeHead(500).end()
    }))

    const apiRequests: RecordedRequest[] = []
    const apiPort = await listen(createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += String(chunk)
      apiRequests.push({
        body: JSON.parse(raw) as Record<string, unknown>,
        headers: req.headers,
        path: req.url ?? '',
      })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: true }))
    }))

    const gatewayPort = await reservePort()
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, ['services/payment-gateway/index.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(gatewayPort),
        ALIPAY_APP_ID: appId,
        ALIPAY_APP_PRIVATE_KEY: merchantPrivateKey,
        ALIPAY_PUBLIC_KEY: alipayPublicKey,
        ALIPAY_GATEWAY_URL: `http://127.0.0.1:${alipayPort}/gateway.do`,
        ALIPAY_REQUEST_TIMEOUT_MS: '1000',
        PAYMENT_GATEWAY_API_KEY: gatewayApiKey,
        PAYMENT_CALLBACK_SECRET: callbackSecret,
        PAYMENT_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
        PUBLIC_BASE_URL: 'https://yxsona.com',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.add(child)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const gatewayBase = `http://127.0.0.1:${gatewayPort}`
    await waitForGateway(gatewayBase, child, () => `${stdout}\n${stderr}`)
    await expect(fetch(`${gatewayBase}/healthz`).then(response => response.json())).resolves.toEqual({
      ok: true,
      supported_channels: ['alipay'],
      channel_readiness: {
        alipay: { ready: true },
      },
    })

    const internalHeaders = {
      authorization: `Bearer ${gatewayApiKey}`,
      'content-type': 'application/json',
    }
    const checkoutResponse = await fetch(`${gatewayBase}/v1/checkout`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({ channel: 'alipay', order_id: 'order-checkout-1', workspace_id: 'ws-checkout-1', amount_fen: 1234, callback_url: 'https://yxsona.com/v1/billing/callback/alipay', description: 'test checkout' }),
    })
    expect(checkoutResponse.status).toBe(200)
    await expect(checkoutResponse.json()).resolves.toMatchObject({ order_id: 'order-checkout-1', workspace_id: 'ws-checkout-1', amount_fen: 1234, provider_order_id: 'order-checkout-1' })
    const unsupportedCheckout = await fetch(`${gatewayBase}/v1/checkout`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({ channel: 'wechat', order_id: 'order-wechat-checkout', workspace_id: 'ws-wechat', amount_fen: 1000 }),
    })
    expect(unsupportedCheckout.status).toBe(503)
    await expect(unsupportedCheckout.json()).resolves.toEqual({ error: 'UNSUPPORTED_PAYMENT_CHANNEL' })
    const unsupportedQuery = await fetch(`${gatewayBase}/v1/query`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({ channel: 'wechat', order_id: 'order-wechat-query' }),
    })
    expect(unsupportedQuery.status).toBe(503)
    await expect(unsupportedQuery.json()).resolves.toEqual({ error: 'UNSUPPORTED_PAYMENT_CHANNEL' })

    const unsupportedRefund = await fetch(`${gatewayBase}/v1/refund`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({ channel: 'wechat', order_id: 'order-wechat-refund', refund_request_id: 'refund-wechat-1', amount_fen: 1000 }),
    })
    expect(unsupportedRefund.status).toBe(503)
    await expect(unsupportedRefund.json()).resolves.toEqual({ error: 'UNSUPPORTED_PAYMENT_CHANNEL' })

    const unscopedRefund = await fetch(`${gatewayBase}/v1/refund`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({ channel: 'alipay', order_id: 'order-alipay-refund', refund_request_id: 'refund-alipay-1', amount_fen: 1000 }),
    })
    expect(unscopedRefund.status).toBe(400)
    await expect(unscopedRefund.json()).resolves.toEqual({ error: 'INVALID_REFUND' })

    const unscopedRefundQuery = await fetch(`${gatewayBase}/v1/refund/query`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({ channel: 'alipay', order_id: 'order-alipay-refund', refund_request_id: 'refund-alipay-1', amount_fen: 1000 }),
    })
    expect(unscopedRefundQuery.status).toBe(400)
    await expect(unscopedRefundQuery.json()).resolves.toEqual({ error: 'INVALID_REFUND_QUERY' })
    expect(alipayCalls).toBe(0)

    const notification = {
      app_id: appId,
      out_trade_no: 'order-alipay-notify-1',
      total_amount: '10.00',
      trade_no: 'trade-alipay-notify-1',
      trade_status: 'TRADE_SUCCESS',
      passback_params: encodePassbackParams({ workspace_id: 'ws-alipay-notify-1', callback_path: '/v1/billing/callback/alipay' }),
      sign_type: 'RSA2',
    }
    const sign = createSign('RSA-SHA256')
      .update(signingContent(notification, { includeSignType: false }), 'utf8')
      .sign(alipayPrivateKey, 'base64')
    const notifyResponse = await fetch(`${gatewayBase}/v1/notify/alipay`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: encodeAlipayParams({ ...notification, sign }),
    })
    expect(notifyResponse.status, `${stdout}\n${stderr}`).toBe(200)
    await expect(notifyResponse.text()).resolves.toBe('success')
    expect(alipayCalls).toBe(0)
    expect(apiRequests).toHaveLength(1)

    const forwarded = apiRequests[0]!
    expect(forwarded.path).toBe('/v1/billing/callback/alipay')
    expect(forwarded.body).toEqual({
      order_id: notification.out_trade_no,
      workspace_id: 'ws-alipay-notify-1',
      provider_trade_id: notification.trade_no,
      amount_fen: 1000,
      currency: 'CNY',
      state: 'paid',
    })
    expect(() => verifyPaymentCallbackSignature({
      secret: callbackSecret,
      channel: 'alipay',
      workspaceId: String(forwarded.body.workspace_id),
      payload: {
        orderId: String(forwarded.body.order_id),
        providerTradeId: String(forwarded.body.provider_trade_id),
        amountFen: Number(forwarded.body.amount_fen),
        currency: forwarded.body.currency as 'CNY',
        state: forwarded.body.state as 'paid',
      },
      signature: String(forwarded.headers['x-payment-signature']),
      timestamp: String(forwarded.headers['x-payment-timestamp']),
      nonce: String(forwarded.headers['x-payment-nonce']),
    })).not.toThrow()

    for (const invalidNotification of [
      { ...notification, total_amount: '0.00' },
      { ...notification, trade_status: 'UNRECOGNIZED_STATUS' },
    ]) {
      const invalidSign = createSign('RSA-SHA256')
        .update(signingContent(invalidNotification, { includeSignType: false }), 'utf8')
        .sign(alipayPrivateKey, 'base64')
      const invalidResponse = await fetch(`${gatewayBase}/v1/notify/alipay`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: encodeAlipayParams({ ...invalidNotification, sign: invalidSign }),
      })
      expect(invalidResponse.status).toBe(400)
      await expect(invalidResponse.json()).resolves.toEqual({ error: 'INVALID_NOTIFY' })
    }
    expect(apiRequests).toHaveLength(1)
  }, 20_000)
})
