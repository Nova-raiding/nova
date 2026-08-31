import { describe, expect, it, vi } from 'vitest'
import { RelayPricingClient, RelayPricingError, createRelayPricingClientFromEnv } from './relay-pricing.js'

const pricing = {
  pricing_version: 'price_v1',
  group_ratio: { SVIP: 0.5, VIP: 0.85 },
  data: [
    { model_name: 'deepseek-v4-pro', quota_type: 0, model_ratio: 0.8785, model_price: 0, completion_ratio: 2, enable_groups: ['SVIP'] },
    { model_name: 'agnes-image-2.1-flash', quota_type: 1, model_ratio: 0, model_price: 0.02, completion_ratio: 0, enable_groups: ['SVIP'] },
    { model_name: 'agnes-video-v2.0', quota_type: 1, model_ratio: 37.5, model_price: 0, completion_ratio: 1, enable_groups: ['VIP'] },
  ],
}

function client(payload = pricing) {
  const fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith('/api/pricing') ? payload : { data: { quota_per_unit: 500_000, usd_exchange_rate: 6.83, quota_display_type: 'CNY' } })))
  return { value: new RelayPricingClient({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', group: 'SVIP', fetch }), fetch }
}

describe('RelayPricingClient', () => {
  it('derives token cost from a frozen relay pricing and currency snapshot', async () => {
    const { value, fetch } = client()
    await expect(value.quote({ modality: 'text', model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 500, totalTokens: 1500, observedAt: new Date().toISOString() })).resolves.toMatchObject({
      costCny: 0.01200714,
      metadata: { pricing_version: 'price_v1', pricing_group: 'SVIP', group_ratio: 0.5, usd_exchange_rate: 6.83, quota_per_unit: 500000, raw_quota: 878.5, rounded_quota: 879, formula_version: 'new-api-quota-v1' },
    })
    await value.quote({ modality: 'ocr', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 1, observedAt: new Date().toISOString() })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('applies fixed image price, count and SVIP ratio', async () => {
    const { value } = client()
    await expect(value.quote({ modality: 'image', model: 'agnes-image-2.1-flash', observedAt: new Date().toISOString(), metadata: { billing_units: 3 } })).resolves.toMatchObject({ costCny: 0.2049 })
  })

  it('uses modality-specific groups without falling back to default', async () => {
    const payload = { ...pricing, data: pricing.data.map(item => ({ ...item, enable_groups: item.model_name === 'deepseek-v4-pro' ? ['VIP'] : ['SVIP'] })) }
    const fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith('/api/pricing') ? payload : { data: { quota_per_unit: 500_000, usd_exchange_rate: 6.83 } })))
    const value = new RelayPricingClient({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', group: 'SVIP', modalityGroups: { text: 'VIP' }, fetch })
    await expect(value.quote({ modality: 'text', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 10, observedAt: new Date().toISOString() })).resolves.toMatchObject({ metadata: { pricing_group: 'VIP', group_ratio: 0.85 } })
    await expect(value.quote({ modality: 'ocr', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 1, observedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'MODEL_PRICING_GROUP_UNAVAILABLE' })
  })

  it('derives duration-priced video cost from request-side duration evidence', async () => {
    const { fetch } = client()
    const value = new RelayPricingClient({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', group: 'VIP', fetch })
    await expect(value.quote({ modality: 'video', model: 'agnes-video-v2.0', observedAt: new Date().toISOString(), metadata: { duration_seconds: 5 } })).resolves.toMatchObject({
      costCny: 544.265625,
      metadata: { pricing_group: 'VIP', raw_quota: 39_843_750, formula_version: 'new-api-quota-v1' },
    })
  })

  it('uses explicit CNY-per-second overrides for quota-ratio video models', async () => {
    const { fetch } = client({
      ...pricing,
      data: [{ model_name: 'happyhorse-1.1-t2v', quota_type: 1, model_ratio: 37.5, model_price: 0, completion_ratio: 1, enable_groups: ['SVIP'] }],
    })
    const value = new RelayPricingClient({
      baseUrl: 'https://relay.example/v1',
      apiKey: 'secret',
      group: 'SVIP',
      videoPriceCnyPerSecond: { 'happyhorse-1.1-t2v': 0.4508 },
      fetch,
    })
    await expect(value.quote({ modality: 'video', model: 'happyhorse-1.1-t2v', observedAt: new Date().toISOString(), metadata: { duration_seconds: 5 } })).resolves.toMatchObject({
      costCny: 2.254,
      metadata: { pricing_group: 'SVIP', video_price_cny_per_second: 0.4508, formula_version: 'relay-video-cny-per-second-v1' },
    })
  })

  it('fails closed when the configured group cannot use the model', async () => {
    const unavailable = { ...pricing, data: pricing.data.map(item => ({ ...item, enable_groups: ['VIP'] })) }
    await expect(client(unavailable).value.quote({ modality: 'text', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 1, observedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'MODEL_PRICING_GROUP_UNAVAILABLE' } satisfies Partial<RelayPricingError>)
  })

  it('does not enable derivation without explicit configuration', () => {
    expect(createRelayPricingClientFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example/v1', MODEL_RELAY_API_KEY: 'secret', MODEL_RELAY_PRICING_GROUP: 'SVIP' })).toBeUndefined()
  })

  it('requires the production relay allowlist before enabling pricing derivation', () => {
    const configured = { NODE_ENV: 'production', MODEL_RELAY_PRICING_DERIVATION_ENABLED: 'true', MODEL_RELAY_BASE_URL: 'https://relay.example/v1', MODEL_RELAY_API_KEY: 'secret', MODEL_RELAY_PRICING_GROUP: 'SVIP' }
    expect(createRelayPricingClientFromEnv(configured)).toBeUndefined()
    expect(createRelayPricingClientFromEnv({ ...configured, MODEL_RELAY_ALLOWED_HOSTS: 'other.example' })).toBeUndefined()
    expect(createRelayPricingClientFromEnv({ ...configured, MODEL_RELAY_ALLOWED_HOSTS: 'relay.example' })).toBeDefined()
  })

  it('blocks pricing fetch before credentials leave the process when the host policy mismatches', async () => {
    const fetch = vi.fn()
    const value = new RelayPricingClient({
      baseUrl: 'https://relay.example.test/v1', apiKey: 'secret', group: 'SVIP', fetch,
      relaySecurity: { environment: 'production', allowedHosts: ['approved.example.test'] },
    })
    await expect(value.quote({ modality: 'text', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 1, observedAt: new Date().toISOString() })).rejects.toThrow('HOST_NOT_ALLOWLISTED')
    expect(fetch).not.toHaveBeenCalled()
  })
})
