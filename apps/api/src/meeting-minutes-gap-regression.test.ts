import { describe, expect, it } from 'vitest'
import { merchantVideoUploadDisabled, paymentChannelDisabled } from './server.js'

describe('2026-09-18 meeting minutes gap guards', () => {
  it('keeps production payment entry points Alipay-only while preserving explicit test control', () => {
    expect(paymentChannelDisabled('wechat', { NODE_ENV: 'production' })).toBe(true)
    expect(paymentChannelDisabled('wechat', { NODE_ENV: 'test' })).toBe(false)
    expect(paymentChannelDisabled('wechat', { NODE_ENV: 'test', PAYMENT_ALIPAY_ONLY: 'true' })).toBe(true)
    expect(paymentChannelDisabled('alipay', { NODE_ENV: 'production' })).toBe(false)
  })

  it('blocks merchant video uploads without blocking document/image assets', () => {
    expect(merchantVideoUploadDisabled('demo.mp4', 'video/mp4')).toBe(true)
    expect(merchantVideoUploadDisabled('demo.webm', 'application/octet-stream')).toBe(true)
    expect(merchantVideoUploadDisabled('brand.png', 'image/png')).toBe(false)
    expect(merchantVideoUploadDisabled('rules.md', 'text/markdown')).toBe(false)
  })
})
