import { generateKeyPairSync, createSign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  decodePassbackParams,
  encodeAlipayParams,
  encodePassbackParams,
  formatAlipayTimestamp,
  normalizePublicKey,
  parseRequestBody,
  responseMatchesOrder,
  responseSignContent,
  signAlipayParams,
  signingContent,
  verifyNotifySignature,
  verifyResponseSignature,
} from '../services/payment-gateway/alipay.mjs'

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const publicKeyPem = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString()

describe('payment gateway Alipay protocol helpers', () => {
  it('formats timestamps in China Standard Time regardless of host TZ', () => {
    expect(formatAlipayTimestamp(new Date('2026-09-12T14:11:16.000Z'))).toBe('2026-09-12 22:11:16')
  })

  it('builds an unencoded canonical request string and excludes only sign/empty fields', () => {
    const params = { z: 'last value', sign_type: 'RSA2', empty: '', sign: 'ignored', app_id: 'demo', unicode: '中文' }
    expect(signingContent(params)).toBe('app_id=demo&sign_type=RSA2&unicode=中文&z=last value')
    expect(signingContent(params, { includeSignType: false })).toBe('app_id=demo&unicode=中文&z=last value')
  })

  it('round-trips form encoding without changing signed values', () => {
    const params = { subject: '中文 商品', plus: 'a+b', percent: '10%', space: 'a b' }
    const encoded = encodeAlipayParams(params)
    expect(parseRequestBody(encoded, 'application/x-www-form-urlencoded; charset=utf-8')).toEqual(params)
  })

  it('supports Alipay public key, RSA public key, certificate, and bare-base64 formats', () => {
    const spki = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const rsaPublicPem = keyPair.publicKey.export({ format: 'pem', type: 'pkcs1' }).toString()
    const normalized = normalizePublicKey(publicKeyPem)
    expect(normalized).toContain('BEGIN PUBLIC KEY')
    expect(normalizePublicKey(rsaPublicPem)).toBe(normalized)
    expect(normalizePublicKey(spki)).toBe(normalized)
  })

  it('verifies documented and legacy notification canonical forms', () => {
    const documented = { app_id: 'demo', out_trade_no: 'order-1', total_amount: '0.01', trade_no: 'trade-1', sign_type: 'RSA2' }
    const documentedSign = createSign('RSA-SHA256').update(signingContent(documented, { includeSignType: false }), 'utf8').sign(privateKeyPem, 'base64')
    expect(verifyNotifySignature({ ...documented, sign: documentedSign }, publicKeyPem, 'demo')).toBe(true)

    const legacySign = signAlipayParams(documented, privateKeyPem)
    expect(verifyNotifySignature({ ...documented, sign: legacySign }, publicKeyPem, 'demo')).toBe(true)
    const omittedSignTypeSign = createSign('RSA-SHA256').update(signingContent({ ...documented, sign_type: 'RSA2' }), 'utf8').sign(privateKeyPem, 'base64')
    const omittedSignType = { ...documented, sign: omittedSignTypeSign } as Record<string, string>
    delete omittedSignType.sign_type
    expect(verifyNotifySignature(omittedSignType, publicKeyPem, 'demo')).toBe(true)
    expect(verifyNotifySignature({ ...documented, sign_type: 'RSA', sign: legacySign }, publicKeyPem, 'demo')).toBe(false)
  })

  it('rejects a valid RSA2 notification signed for a different Alipay app', () => {
    const otherApp = { app_id: 'other-app', out_trade_no: 'order-1', total_amount: '0.01', trade_no: 'trade-other', sign_type: 'RSA2' }
    const signature = createSign('RSA-SHA256').update(signingContent(otherApp, { includeSignType: false }), 'utf8').sign(privateKeyPem, 'base64')
    expect(verifyNotifySignature({ ...otherApp, sign: signature }, publicKeyPem, 'demo')).toBe(false)
    expect(verifyNotifySignature({ ...otherApp, sign: signature }, publicKeyPem, 'other-app')).toBe(true)
    expect(verifyNotifySignature({ ...otherApp, sign: signature }, publicKeyPem, '')).toBe(false)
  })

  it('encodes passback_params once inside biz_content and decodes both forms', () => {
    const context = { workspace_id: 'ws_demo', callback_path: '/v1/billing/callback/alipay' }
    const encoded = encodePassbackParams(context)
    expect(encoded).not.toContain('{')
    expect(decodePassbackParams(encoded)).toEqual(context)
    expect(decodePassbackParams(JSON.stringify(context))).toEqual(context)
  })

  it('verifies the exact raw response object bytes and rejects tampering', () => {
    const response = { code: '10000', msg: 'Success', nested: { quote: '}' }, unicode: '中文' }
    const responseContent = JSON.stringify(response)
    const signature = createSign('RSA-SHA256').update(responseContent, 'utf8').sign(privateKeyPem, 'base64')
    const raw = JSON.stringify({ alipay_trade_query_response: response, sign: signature })
    expect(responseSignContent(raw, 'alipay.trade.query')).toBe(responseContent)
    expect(verifyResponseSignature(raw, 'alipay.trade.query', publicKeyPem)).toBe(true)
    expect(verifyResponseSignature(raw.replace('Success', 'Tampered'), 'alipay.trade.query', publicKeyPem)).toBe(false)
    expect(verifyResponseSignature(raw, 'alipay.trade.refund', publicKeyPem)).toBe(false)
  })

  it('rejects nested or duplicate response keys that could desynchronize verification from JSON.parse', () => {
    const signedResponse = { code: '10000', msg: 'Success', trade_status: 'WAIT_BUYER_PAY', out_trade_no: 'safe-order' }
    const signedContent = JSON.stringify(signedResponse)
    const signature = createSign('RSA-SHA256').update(signedContent, 'utf8').sign(privateKeyPem, 'base64')
    const duplicateRaw = `{"alipay_trade_query_response":${signedContent},"alipay_trade_query_response":{"code":"10000","msg":"Success","trade_status":"TRADE_SUCCESS","out_trade_no":"attacker-order"},"sign":"${signature}"}`
    const nestedRaw = `{"metadata":{"alipay_trade_query_response":${signedContent}},"alipay_trade_query_response":{"code":"10000","msg":"Success","trade_status":"TRADE_SUCCESS","out_trade_no":"attacker-order"},"sign":"${signature}"}`

    expect(verifyResponseSignature(duplicateRaw, 'alipay.trade.query', publicKeyPem)).toBe(false)
    expect(verifyResponseSignature(nestedRaw, 'alipay.trade.query', publicKeyPem)).toBe(false)
  })

  it('rejects duplicate top-level signature fields', () => {
    const response = { code: '10000', msg: 'Success' }
    const responseContent = JSON.stringify(response)
    const signature = createSign('RSA-SHA256').update(responseContent, 'utf8').sign(privateKeyPem, 'base64')
    const raw = `{"alipay_trade_query_response":${responseContent},"sign":"${signature}","sign":"tampered"}`
    expect(verifyResponseSignature(raw, 'alipay.trade.query', publicKeyPem)).toBe(false)
  })

  it('binds provider trade responses to the requested merchant order', () => {
    expect(responseMatchesOrder({ out_trade_no: 'order-1', trade_no: 'trade-1' }, 'order-1')).toBe(true)
    expect(responseMatchesOrder({ out_trade_no: 'order-2', trade_no: 'trade-2' }, 'order-1')).toBe(false)
    expect(responseMatchesOrder({ trade_status: 'WAIT_BUYER_PAY' }, 'order-1')).toBe(false)
    expect(responseMatchesOrder({ code: '10000' }, 'order-1')).toBe(false)
    expect(responseMatchesOrder({ code: '40004', msg: 'Order not found' }, 'order-1')).toBe(true)
    expect(responseMatchesOrder({}, 'order-1')).toBe(true)
    expect(responseMatchesOrder({}, '')).toBe(false)
  })
})
