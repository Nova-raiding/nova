import { describe, expect, it } from 'vitest'
import { deploymentMode, isManualTransferPayment, paymentCapabilityStatus, paymentRuntimeMode } from './server.js'

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
    },
  }

  it('requires explicit lean/full deployment mode for the manual transfer contract', () => {
    expect(deploymentMode({ DEPLOYMENT_MODE: 'lean' })).toBe('lean')
    expect(deploymentMode({ DEPLOYMENT_MODE: 'full' })).toBe('full')
    expect(deploymentMode({ DEPLOYMENT_MODE: 'fixture' })).toBeUndefined()
    expect(paymentRuntimeMode({ DEPLOYMENT_MODE: 'lean', PAYMENT_MODE: 'manual_transfer' })).toBe('manual_transfer')
    expect(isManualTransferPayment({ DEPLOYMENT_MODE: 'lean', PAYMENT_MODE: 'manual_transfer' })).toBe(true)
    expect(isManualTransferPayment({ DEPLOYMENT_MODE: 'full', PAYMENT_MODE: 'manual_transfer' })).toBe(false)
  })

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

  it('reports lean manual transfer as a real production capability, never fixture', () => {
    expect(paymentCapabilityStatus({
      ...base,
      mode: 'manual_transfer',
      providerReady: false,
      supportedChannels: [],
      channelReadiness: {},
    })).toMatchObject({
      provider_configured: false,
      configured: true,
      effective: true,
      production_enabled: true,
      state: 'enabled',
      supported_channels: [],
    })
  })

  it('keeps lean manual transfer blocked until production gates pass', () => {
    expect(paymentCapabilityStatus({
      ...base,
      mode: 'manual_transfer',
      providerReady: false,
      productionGate: false,
      supportedChannels: [],
      channelReadiness: {},
    })).toMatchObject({
      provider_configured: false,
      configured: true,
      effective: false,
      production_enabled: false,
      state: 'configured_but_blocked',
      reasons: ['payment_production_gate_blocked'],
    })
  })
})
