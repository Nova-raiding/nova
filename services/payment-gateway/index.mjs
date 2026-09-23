import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import {
  decodePassbackParams,
  encodeAlipayParams,
  encodePassbackParams,
  formatAlipayTimestamp,
  normalizePublicKey,
  normalizeRefundQueryState,
  normalizeRefundSubmissionState,
  parseRequestBody,
  refundQueryResponseMatchesRequest,
  responseMatchesOrder,
  signAlipayParams,
  verifiedNotifySigningContent,
  verifyResponseSignature,
} from './alipay.mjs'
import { signPaymentCallback } from '../../packages/billing/src/callback-envelope.mjs'
import { captureGatewayOperationReceipt, captureVerifiedNotifyReceipt } from './protected-receipt.mjs'

const env = name => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value }
const port = Number(process.env.PORT || 8790)
const appId = env('ALIPAY_APP_ID')
const readSecret = (valueName, pathName) => process.env[pathName]?.trim() ? fs.readFileSync(process.env[pathName].trim(), 'utf8') : env(valueName).replace(/\\n/g, '\n')
const privateKey = readSecret('ALIPAY_APP_PRIVATE_KEY', 'ALIPAY_APP_PRIVATE_KEY_PATH')
const publicKey = normalizePublicKey(readSecret('ALIPAY_PUBLIC_KEY', 'ALIPAY_PUBLIC_KEY_PATH'))
const gateway = process.env.ALIPAY_GATEWAY_URL || 'https://openapi.alipay.com/gateway.do'
const serviceKey = env('PAYMENT_GATEWAY_API_KEY')
const callbackSecret = env('PAYMENT_CALLBACK_SECRET')
const apiBase = env('PAYMENT_API_BASE_URL').replace(/\/$/, '')
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || 'https://yxsona.com').replace(/\/$/, '')
const alipayRequestTimeoutMs = (() => {
  const raw = process.env.ALIPAY_REQUEST_TIMEOUT_MS?.trim()
  if (!raw) return 10_000
  if (!/^\d+$/u.test(raw)) throw new Error('ALIPAY_REQUEST_TIMEOUT_MS must be an integer')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) throw new Error('ALIPAY_REQUEST_TIMEOUT_MS must be between 1000 and 120000')
  return value
})()

const json = (res, status, value) => { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body) }
async function body(req) { let value = ''; for await (const chunk of req) { value += chunk; if (value.length > 131072) throw new Error('request too large') } return parseRequestBody(value, req.headers['content-type'] || '') }
function signedParams(method, content, notifyUrl) { const p = { app_id: appId, method, format: 'JSON', charset: 'utf-8', sign_type: 'RSA2', timestamp: formatAlipayTimestamp(), version: '1.0', biz_content: JSON.stringify(content), ...(notifyUrl ? { notify_url: notifyUrl } : {}) }; return { ...p, sign: signAlipayParams(p, privateKey) } }
function urlFor(params) { return `${gateway}?${encodeAlipayParams(params)}` }
function requestContext() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), alipayRequestTimeoutMs)
  timer.unref?.()
  return { controller, close: () => clearTimeout(timer) }
}
function upstreamError(error, controller) {
  if (controller.signal.aborted) return new Error('alipay_request_timeout')
  if (error instanceof Error && /^(?:alipay_http_\d{3}|alipay_invalid_response_signature|alipay_invalid_response)$/u.test(error.message)) return error
  return new Error('alipay_request_failed')
}
async function callAlipay(method, content) {
  const params = signedParams(method, content)
  const request = requestContext()
  try {
    const response = await fetch(gateway, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/json' }, body: encodeAlipayParams(params), redirect: 'error', signal: request.controller.signal })
    if (!response.ok) throw new Error(`alipay_http_${response.status}`)
    const raw = await response.text()
    if (!verifyResponseSignature(raw, method, publicKey)) throw new Error('alipay_invalid_response_signature')
    try {
      return { document: JSON.parse(raw), signedResponseSha256: crypto.createHash('sha256').update(raw).digest('hex') }
    } catch {
      throw new Error('alipay_invalid_response')
    }
  } catch (error) {
    throw upstreamError(error, request.controller)
  } finally {
    request.close()
  }
}
async function forward(input) {
  const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = crypto.randomBytes(18).toString('base64url'); const currency = 'CNY'
  const request = requestContext()
  try {
    const callbackPath = ['/v1/billing/callback/alipay', '/v1/subscriptions/callback/alipay', '/v1/commercial/callback/alipay'].includes(input.callbackPath) ? input.callbackPath : '/v1/billing/callback/alipay'
    const signature = signPaymentCallback({ secret: callbackSecret, channel: 'alipay', workspaceId: input.workspaceId, orderId: input.orderId, providerTradeId: input.tradeNo, amountFen: input.amountFen, currency, state: input.state, timestamp, nonce })
    return await fetch(`${apiBase}${callbackPath}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment-signature': signature, 'x-payment-timestamp': timestamp, 'x-payment-nonce': nonce }, body: JSON.stringify({ order_id: input.orderId, workspace_id: input.workspaceId, provider_trade_id: input.tradeNo, amount_fen: input.amountFen, currency, state: input.state }), signal: request.controller.signal })
  } catch (error) {
    throw upstreamError(error, request.controller)
  } finally {
    request.close()
  }
}
async function handle(req, res) {
  if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { ok: true, supported_channels: ['alipay'], channel_readiness: { alipay: { ready: true } } })
  if (req.url !== '/v1/notify/alipay' && req.headers.authorization !== `Bearer ${serviceKey}`) return json(res, 401, { error: 'UNAUTHORIZED' })
  if (req.method === 'POST' && req.url === '/v1/checkout') { const input = await body(req); if (input.channel !== 'alipay') return json(res, 503, { error: 'UNSUPPORTED_PAYMENT_CHANNEL' }); const amountFen = Number(input.amount_fen); if (!input.order_id || !input.workspace_id || !Number.isSafeInteger(amountFen) || amountFen <= 0) return json(res, 400, { error: 'INVALID_CHECKOUT' }); let callbackPath = '/v1/billing/callback/alipay'; try { const callback = new URL(String(input.callback_url || `${publicBaseUrl}${callbackPath}`)); if (callback.protocol !== 'https:' || callback.origin !== publicBaseUrl || !['/v1/billing/callback/alipay', '/v1/subscriptions/callback/alipay', '/v1/commercial/callback/alipay'].includes(callback.pathname)) return json(res, 400, { error: 'INVALID_CALLBACK_URL' }); callbackPath = callback.pathname } catch { return json(res, 400, { error: 'INVALID_CALLBACK_URL' }) } const notify = new URL('/payment-gateway/v1/notify/alipay', publicBaseUrl).toString(); const params = signedParams('alipay.trade.page.pay', { out_trade_no: String(input.order_id), total_amount: (amountFen / 100).toFixed(2), subject: String(input.description || 'merchant-marketing').slice(0, 256), product_code: 'FAST_INSTANT_TRADE_PAY', passback_params: encodePassbackParams({ workspace_id: String(input.workspace_id), callback_path: callbackPath }) }, notify); captureGatewayOperationReceipt({ directory: process.env.PAYMENT_PROTECTED_RECEIPT_DIR, operation: 'checkout', orderId: String(input.order_id), workspaceId: String(input.workspace_id), amountFen, signedCheckoutParams: encodeAlipayParams(params), outcome: 'created' }); return json(res, 200, { payment_url: urlFor(params), provider_order_id: String(input.order_id), order_id: String(input.order_id), workspace_id: String(input.workspace_id), amount_fen: amountFen }) }
  if (req.method === 'POST' && req.url === '/v1/query') {
    const input = await body(req)
    if (input.channel !== 'alipay') return json(res, 503, { error: 'UNSUPPORTED_PAYMENT_CHANNEL' })
    const orderId = typeof input.order_id === 'string' ? input.order_id.trim() : ''
    const workspaceId = typeof input.workspace_id === 'string' ? input.workspace_id.trim() : ''
    if (!orderId || !workspaceId) return json(res, 400, { error: 'INVALID_QUERY' })
    const node = (await callAlipay('alipay.trade.query', { out_trade_no: orderId })).document.alipay_trade_query_response || {}
    if (!responseMatchesOrder(node, orderId)) throw new Error('alipay_response_order_mismatch')
    const state = node.trade_status === 'TRADE_SUCCESS' || node.trade_status === 'TRADE_FINISHED' ? 'paid' : node.trade_status === 'TRADE_CLOSED' ? 'closed' : 'pending'
    if (state === 'paid') captureGatewayOperationReceipt({ directory: process.env.PAYMENT_PROTECTED_RECEIPT_DIR, operation: 'provider_query', orderId, workspaceId, providerTradeId: node.trade_no, providerResponseReference: node.trade_no, amountFen: Math.round(Number(node.total_amount) * 100), providerResponseSignatureVerified: true, outcome: state })
    return json(res, 200, { state, order_id: orderId, workspace_id: workspaceId, trade_no: node.trade_no, amount_fen: node.total_amount ? Math.round(Number(node.total_amount) * 100) : undefined })
  }
  if (req.method === 'POST' && req.url === '/v1/refund') {
    const input = await body(req)
    if (input.channel !== 'alipay') return json(res, 503, { error: 'UNSUPPORTED_PAYMENT_CHANNEL' })
    const orderId = typeof input.order_id === 'string' ? input.order_id.trim() : ''
    const refundRequestId = typeof input.refund_request_id === 'string' ? input.refund_request_id.trim() : ''
    const workspaceId = typeof input.workspace_id === 'string' ? input.workspace_id.trim() : ''
    const amountFen = Number(input.amount_fen)
    const providerTradeId = typeof input.provider_trade_id === 'string' ? input.provider_trade_id.trim() : ''
    if (!orderId || !refundRequestId || !workspaceId || !providerTradeId || !Number.isSafeInteger(amountFen) || amountFen <= 0) return json(res, 400, { error: 'INVALID_REFUND' })
    const node = (await callAlipay('alipay.trade.refund', { trade_no: providerTradeId, refund_amount: (amountFen / 100).toFixed(2), refund_reason: input.reason || 'merchant refund', out_request_no: refundRequestId })).document.alipay_trade_refund_response || {}
    if (!responseMatchesOrder(node, orderId)) throw new Error('alipay_response_order_mismatch')
    const state = normalizeRefundSubmissionState(node)
    captureGatewayOperationReceipt({ directory: process.env.PAYMENT_PROTECTED_RECEIPT_DIR, operation: 'refund', orderId, workspaceId, providerTradeId, providerResponseReference: node.trade_no || providerTradeId, refundRequestId, amountFen, providerResponseSignatureVerified: true, outcome: state })
    return json(res, 200, { order_id: orderId, provider_refund_id: node.trade_no || orderId, refund_request_id: refundRequestId, workspace_id: workspaceId, amount_fen: amountFen, state })
  }
  if (req.method === 'POST' && req.url === '/v1/refund/query') {
    const input = await body(req)
    if (input.channel !== 'alipay') return json(res, 503, { error: 'UNSUPPORTED_PAYMENT_CHANNEL' })
    const orderId = typeof input.order_id === 'string' ? input.order_id.trim() : ''
    const refundRequestId = typeof input.refund_request_id === 'string' ? input.refund_request_id.trim() : ''
    const workspaceId = typeof input.workspace_id === 'string' ? input.workspace_id.trim() : ''
    const amountFen = Number(input.amount_fen)
    if (!orderId || !refundRequestId || !workspaceId || !Number.isSafeInteger(amountFen) || amountFen <= 0) return json(res, 400, { error: 'INVALID_REFUND_QUERY' })
    const providerResponse = await callAlipay('alipay.trade.fastpay.refund.query', { out_trade_no: orderId, out_request_no: refundRequestId })
    const node = providerResponse.document.alipay_trade_fastpay_refund_query_response || {}
    if (!refundQueryResponseMatchesRequest(node, orderId, refundRequestId, amountFen)) throw new Error('alipay_refund_query_mismatch')
    const state = normalizeRefundQueryState(node)
    if (state === 'succeeded') {
      if (typeof node.trade_no !== 'string' || !node.trade_no.trim()) throw new Error('alipay_refund_query_mismatch')
      captureGatewayOperationReceipt({ directory: process.env.PAYMENT_PROTECTED_RECEIPT_DIR, operation: 'refund_query', orderId, workspaceId, providerTradeId: node.trade_no, providerResponseReference: node.trade_no, refundRequestId, amountFen, providerResponseSignatureVerified: true, signedResponseSha256: providerResponse.signedResponseSha256, providerNativeStatus: node.refund_status, outcome: state })
    }
    return json(res, 200, { state, ...(state === 'unknown' ? {} : { order_id: orderId, provider_refund_id: node.trade_no || orderId, refund_request_id: refundRequestId, workspace_id: workspaceId, amount_fen: amountFen }) })
  }
  if (req.method === 'POST' && req.url === '/v1/notify/alipay') {
    const input = await body(req)
    const nativeSignedFields = verifiedNotifySigningContent(input, publicKey, appId)
    if (nativeSignedFields === null) return json(res, 400, { error: 'INVALID_ALIPAY_SIGNATURE' })
    const context = decodePassbackParams(String(input.passback_params || ''))
    const amountText = String(input.total_amount ?? '').trim()
    const amountFen = /^\d+(?:\.\d{1,2})?$/u.test(amountText) ? Math.round(Number(amountText) * 100) : Number.NaN
    const states = { TRADE_SUCCESS: 'paid', TRADE_FINISHED: 'paid', TRADE_CLOSED: 'closed', WAIT_BUYER_PAY: 'pending' }
    const state = states[String(input.trade_status ?? '').trim()]
    if (!context.workspace_id || !input.out_trade_no || !input.trade_no || !Number.isSafeInteger(amountFen) || amountFen <= 0 || !state) return json(res, 400, { error: 'INVALID_NOTIFY' })
    const callbackPath = ['/v1/billing/callback/alipay', '/v1/subscriptions/callback/alipay', '/v1/commercial/callback/alipay'].includes(String(context.callback_path || ''))
      ? String(context.callback_path)
      : '/v1/billing/callback/alipay'
    const response = await forward({ workspaceId: String(context.workspace_id), orderId: String(input.out_trade_no), tradeNo: String(input.trade_no), amountFen, state, callbackPath })
    if (!response.ok) return json(res, 502, { error: 'API_CALLBACK_FAILED' })
    captureVerifiedNotifyReceipt({
      directory: process.env.PAYMENT_PROTECTED_RECEIPT_DIR,
      providerSignatureVerified: true,
      nativeSignature: String(input.sign),
      nativeSignedFields,
      apiCallbackStatus: response.status,
      callbackPath,
      orderId: String(input.out_trade_no),
      providerTradeId: String(input.trade_no),
      workspaceId: String(context.workspace_id),
      amountFen,
      state,
    })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('success')
    return
  }
  return json(res, 404, { error: 'NOT_FOUND' })
}
http.createServer((req, res) => handle(req, res).catch(error => json(res, 500, { error: 'GATEWAY_ERROR', code: error instanceof Error && /^(?:alipay_http_\d{3}|alipay_request_timeout|alipay_request_failed|alipay_invalid_response_signature|alipay_invalid_response|alipay_response_order_mismatch|alipay_refund_query_mismatch)$/u.test(error.message) ? error.message : 'gateway_failure' }))).listen(port, '0.0.0.0')
