import { describe, expect, it } from 'vitest'
import { paymentCapabilityStatus } from './server.js'

describe('payment capability status', () => {
  const base = {
    mode: 'provider',
    providerReady: true,
    production: true,
    fixtureMode: false,
    productionGate: true,
    reasons: [],
    supportedChannels: ['alipay'] as const,
    channelReadiness: {
      alipay: { ready: true, reasons: [] },
      wechat: { ready: false, reasons: ['provider_adapter_not_implemented'] },
    },
  }

  it('does not advertise a fixture provider as configured or usable', () => {
    expect(paymentCapabilityStatus({ ...base, fixtureMode: true, productionGate: false })).toMatchObject({
      provider_configured: true,
      configured: false,
      effective: false,
      production_enabled: false,
      state: 'not_configured',
      reasons: ['payment_fixture_mode_blocked'],
    })
  })

  it('keeps a real provider visibly blocked until the whole production gate passes', () => {
    expect(paymentCapabilityStatus({ ...base, productionGate: false })).toMatchObject({
      provider_configured: true,
      configured: true,
      effective: false,
      production_enabled: false,
      state: 'configured_but_blocked',
      reasons: ['payment_production_gate_blocked'],
    })
  })

  it('enables payment only in production with all gates open', () => {
    expect(paymentCapabilityStatus(base)).toMatchObject({
      provider_configured: true,
      configured: true,
      effective: true,
      production_enabled: true,
      state: 'enabled',
      supported_channels: ['alipay'],
      channel_readiness: {
        alipay: { ready: true, reasons: [] },
        wechat: { ready: false, reasons: ['provider_adapter_not_implemented'] },
      },
      reasons: [],
    })
  })

  it('reports missing provider configuration without claiming a blocked provider', () => {
    expect(paymentCapabilityStatus({ ...base, providerReady: false, reasons: ['provider_api_key_missing'] })).toMatchObject({
      provider_configured: false,
      configured: false,
      effective: false,
      production_enabled: false,
      state: 'not_configured',
      reasons: ['provider_api_key_missing'],
    })
  })
})
