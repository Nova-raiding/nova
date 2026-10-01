import { describe, expect, it, vi } from 'vitest'
import { evaluatePlatformModelBudgetEstimate, evaluatePlatformModelCostGate, evaluatePlatformModelGate, evaluatePlatformModelRelayGate, evaluatePlatformModelRequestCost, evaluatePlatformModelTaskCostLimit, evaluatePlatformModelTaskRequestCost, startPlatformRelayTokenQuotaMonitor } from './platform-model-gate.js'

describe('platform-owned model gate', () => {
  it('blocks production readiness and dispatch for unknown, unlimited and expired relay tokens', async () => {
    const source = { NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://relay.example/v1', MODEL_RELAY_ALLOWED_HOSTS: 'relay.example', MODEL_RELAY_API_KEY: 'model-key', VIDEO_MODEL_RELAY_API_KEY: 'video-key', AI_MODEL: 'text-v1', VIDEO_MODEL: 'video-v1' }
    let resolveModel!: (response: Response) => void
    let resolveVideo!: (response: Response) => void
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>(resolve => {
      if (init?.headers && (init.headers as Record<string, string>).authorization === 'Bearer model-key') resolveModel = resolve
      else resolveVideo = resolve
    })) as unknown as typeof fetch
    const stop = startPlatformRelayTokenQuotaMonitor(source, fetcher)
    const quota = (unlimited: boolean, expiresAt: number) => new Response(JSON.stringify({ code: true, data: { object: 'token_usage', unlimited_quota: unlimited, total_granted: 100, total_used: 20, total_available: 80, expires_at: expiresAt } }), { status: 200 })
    try {
      expect(evaluatePlatformModelRelayGate(source)).toMatchObject({ ready: false, reasons: expect.arrayContaining(['relay_token_quota_unknown']) })
      expect(evaluatePlatformModelGate(source, 'text')).toMatchObject({ ready: false })
      resolveModel(quota(true, Math.floor(Date.now() / 1000) + 3600))
      resolveVideo(quota(false, Math.floor(Date.now() / 1000) - 1))
      await vi.waitFor(() => expect(evaluatePlatformModelRelayGate(source).reasons).toEqual(expect.arrayContaining(['relay_token_quota_unlimited', 'relay_token_quota_expired_or_exhausted'])))
      expect(evaluatePlatformModelGate(source, 'text').reasons).toContain('relay_token_quota_unlimited')
      expect(evaluatePlatformModelGate(source, 'video').reasons).toContain('relay_token_quota_expired_or_exhausted')
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher).toHaveBeenCalledWith(new URL('https://relay.example/api/usage/token/'), expect.objectContaining({ redirect: 'error' }))
    } finally { stop() }
  })

  it('opens only after both current finite token receipts arrive and closes on quota lookup failure', async () => {
    const source = { NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://relay.example/v1', MODEL_RELAY_ALLOWED_HOSTS: 'relay.example', MODEL_RELAY_API_KEY: 'model-key', VIDEO_MODEL_RELAY_API_KEY: 'video-key', AI_MODEL: 'text-v1', VIDEO_MODEL: 'video-v1' }
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.headers as Record<string, string>)?.authorization === 'Bearer video-key') return new Response('', { status: 401 })
      return new Response(JSON.stringify({ code: true, data: { object: 'token_usage', unlimited_quota: false, total_granted: 100, total_used: 20, total_available: 80, expires_at: 0 } }), { status: 200 })
    }) as unknown as typeof fetch
    const stop = startPlatformRelayTokenQuotaMonitor(source, fetcher)
    try {
      await vi.waitFor(() => expect(evaluatePlatformModelGate(source, 'text').ready).toBe(true))
      await vi.waitFor(() => expect(evaluatePlatformModelGate(source, 'video').reasons).toContain('relay_token_auth_failed'))
      expect(evaluatePlatformModelRelayGate(source).ready).toBe(false)
      expect(evaluatePlatformModelRelayGate(source, 'model').ready).toBe(true)
      expect(evaluatePlatformModelRelayGate(source, 'video').reasons).toContain('relay_token_auth_failed')
      expect(fetcher).toHaveBeenCalledTimes(2)
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 91_000)
      try { expect(evaluatePlatformModelRelayGate(source, 'model').reasons).toContain('relay_token_quota_stale') }
      finally { clock.mockRestore() }
    } finally { stop() }
  })
  it('classifies quota endpoint rate limiting separately and does not retry during Retry-After', async () => {
    vi.useFakeTimers()
    const source = { NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://relay.example/v1', MODEL_RELAY_ALLOWED_HOSTS: 'relay.example', MODEL_RELAY_API_KEY: 'model-key', VIDEO_MODEL_RELAY_API_KEY: 'video-key', AI_MODEL: 'text-v1', VIDEO_MODEL: 'video-v1' }
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>)?.authorization
      if (authorization === 'Bearer model-key') return new Response('', { status: 429, headers: { 'retry-after': '120' } })
      return new Response(JSON.stringify({ code: true, data: { object: 'token_usage', unlimited_quota: false, total_granted: 100, total_used: 20, total_available: 80, expires_at: 0 } }), { status: 200 })
    }) as unknown as typeof fetch
    const stop = startPlatformRelayTokenQuotaMonitor(source, fetcher)
    try {
      await vi.waitFor(() => expect(evaluatePlatformModelGate(source, 'text').reasons).toContain('relay_token_quota_rate_limited'))
      expect(evaluatePlatformModelGate(source, 'text').ready).toBe(false)
      expect(evaluatePlatformModelGate(source, 'video').ready).toBe(true)
      // The model monitor honors the relay's 120s Retry-After. The independent
      // video credential is still allowed to refresh on its own 30s cadence.
      expect(fetcher).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(fetcher.mock.calls.filter(([, init]) => (init?.headers as Record<string, string>)?.authorization === 'Bearer model-key')).toHaveLength(1)
      expect(fetcher).toHaveBeenCalledTimes(5)
    } finally { stop(); vi.useRealTimers() }
  })
  it('keeps each credential Retry-After independent so one key cannot stale the other', async () => {
    vi.useFakeTimers()
    const source = { NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://relay.example/v1', MODEL_RELAY_ALLOWED_HOSTS: 'relay.example', MODEL_RELAY_API_KEY: 'model-key', VIDEO_MODEL_RELAY_API_KEY: 'video-key', AI_MODEL: 'text-v1', VIDEO_MODEL: 'video-v1' }
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response('', {
      status: 429,
      headers: { 'retry-after': (init?.headers as Record<string, string>)?.authorization === 'Bearer model-key' ? '120' : '30' },
    })) as unknown as typeof fetch
    const stop = startPlatformRelayTokenQuotaMonitor(source, fetcher)
    try {
      await vi.waitFor(() => expect(evaluatePlatformModelGate(source, 'video').reasons).toContain('relay_token_quota_rate_limited'))
      await vi.advanceTimersByTimeAsync(90_000)
      // The video key may retry after its 30s window, while the model key
      // remains protected by its own 120s window. A shared timer would skip
      // the model refresh and incorrectly turn a healthy model quota stale.
      expect(fetcher).toHaveBeenCalledTimes(4)
      expect(evaluatePlatformModelRelayGate(source).ready).toBe(false)
      expect(evaluatePlatformModelRelayGate(source, 'video').reasons).toContain('relay_token_quota_rate_limited')
    } finally { stop(); vi.useRealTimers() }
  })
  it('requires an explicit versioned conservative estimate for every modality', () => {
    expect(evaluatePlatformModelBudgetEstimate({}, 'text')).toMatchObject({ ready: false, reasons: ['request_estimate_missing_or_invalid', 'estimate_version_missing'] })
    const source = { MODEL_COST_ESTIMATE_VERSION: 'pricing-2026-08-29', MODEL_TEXT_MAX_REQUEST_CNY: '0.25', MODEL_IMAGE_MAX_REQUEST_CNY: '1.50', MODEL_IMAGE_EDIT_MAX_REQUEST_CNY: '1.75', MODEL_OCR_MAX_REQUEST_CNY: '0.40', MODEL_VIDEO_MAX_REQUEST_CNY: '600' }
    expect((['text', 'image', 'image_edit', 'ocr', 'video'] as const).map(kind => evaluatePlatformModelBudgetEstimate(source, kind))).toEqual([
      expect.objectContaining({ ready: true, amountCny: 0.25, version: 'pricing-2026-08-29' }),
      expect.objectContaining({ ready: true, amountCny: 1.5 }), expect.objectContaining({ ready: true, amountCny: 1.75 }), expect.objectContaining({ ready: true, amountCny: 0.4 }), expect.objectContaining({ ready: true, amountCny: 600 }),
    ])
  })

  it('keeps the per-task cap distinct from the workspace daily budget', () => {
    const source = { MODEL_MAX_TASK_COST_CNY: '0.50', MODEL_DAILY_CNY_LIMIT: '100' }
    expect(evaluatePlatformModelTaskCostLimit(source)).toMatchObject({ ready: true, limitCny: 0.5 })
    expect(evaluatePlatformModelTaskRequestCost(0.5, source)).toMatchObject({ ready: true })
    expect(evaluatePlatformModelTaskRequestCost(0.500001, source)).toMatchObject({ ready: false, reasons: ['request_cost_exceeds_task_limit'] })
    expect(evaluatePlatformModelTaskCostLimit({ MODEL_MAX_TASK_COST_CNY: '101', MODEL_DAILY_CNY_LIMIT: '100' })).toMatchObject({ ready: false, reasons: ['task_cny_limit_exceeds_daily_limit'] })
  })

  it('accepts a realistic video reservation without weakening the daily batch ceiling', () => {
    const source = { MODEL_MAX_TASK_COST_CNY: '2000', MODEL_DAILY_CNY_LIMIT: '5000' }
    expect(evaluatePlatformModelTaskRequestCost(20, source)).toMatchObject({ ready: true, costCny: 20, limitCny: 2000 })
    expect(evaluatePlatformModelTaskRequestCost(2000.01, source)).toMatchObject({ ready: false, reasons: ['request_cost_exceeds_task_limit'] })
  })
  it('requires HTTPS, platform credential and pinned model', () => {
    expect(evaluatePlatformModelGate({ AI_BASE_URL: 'https://model.example', AI_API_KEY: 'platform-secret', AI_MODEL: 'text-v1' }, 'text')).toMatchObject({ ready: false, reasons: ['endpoint_missing', 'api_key_missing'] })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'http://relay.example', MODEL_RELAY_API_KEY: 'platform-secret', AI_MODEL: 'text-v1' }, 'text')).toMatchObject({ ready: false, reasons: ['endpoint_must_use_https'] })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'platform-secret', AI_MODEL: 'text-v1' }, 'text')).toMatchObject({ ready: true, endpointHost: 'relay.example' })
  })

  it('requires all platform cost controls before allowing model traffic', () => {
    expect(evaluatePlatformModelCostGate({ MODEL_RPM_LIMIT: '100', MODEL_TPM_LIMIT: '10000' })).toMatchObject({ ready: false, reasons: ['daily_cny_limit_missing_or_invalid'] })
    expect(evaluatePlatformModelCostGate({ MODEL_RPM_LIMIT: '100', MODEL_TPM_LIMIT: '10000', MODEL_DAILY_CNY_LIMIT: '50.00' })).toMatchObject({ ready: true, dailyCnyLimit: 50 })
  })

  it('blocks a single provider request that already exceeds the daily CNY ceiling', () => {
    expect(evaluatePlatformModelRequestCost(5, 10)).toMatchObject({ ready: true, reasons: [] })
    expect(evaluatePlatformModelRequestCost(544.265625, 10)).toMatchObject({ ready: false, reasons: ['request_cost_exceeds_daily_limit'] })
    expect(evaluatePlatformModelRequestCost(Number.NaN, 10)).toMatchObject({ ready: false, reasons: ['request_cost_missing_or_invalid'] })
  })

  it('requires a platform-owned HTTPS relay endpoint', () => {
    expect(evaluatePlatformModelRelayGate({})).toMatchObject({ ready: false, reasons: ['model_relay_endpoint_missing'] })
    expect(evaluatePlatformModelRelayGate({ MODEL_RELAY_BASE_URL: 'http://relay.example' })).toMatchObject({ ready: false, reasons: ['model_relay_endpoint_must_use_https'] })
    expect(evaluatePlatformModelRelayGate({ MODEL_RELAY_BASE_URL: 'https://relay.example' })).toMatchObject({ ready: true, endpointHost: 'relay.example' })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', AI_API_KEY: 'direct-key', AI_MODEL: 'text-v1' }, 'text')).toMatchObject({ ready: false, reasons: ['api_key_missing'] })
  })

  it('never reports a relay ready that the runtime security boundary refuses', () => {
    // `relaySecurityFromEnv` returns undefined for these endpoints, so no
    // adapter is ever assembled: readiness must not claim otherwise.
    const privateHost = { NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://10.20.30.40/v1', MODEL_RELAY_ALLOWED_HOSTS: 'relay.example', MODEL_RELAY_API_KEY: 'relay-key', AI_MODEL: 'text-v1' }
    expect(evaluatePlatformModelRelayGate(privateHost)).toMatchObject({ ready: false, reasons: expect.arrayContaining(['model_relay_host_blocked']) })
    expect(evaluatePlatformModelGate(privateHost, 'text')).toMatchObject({ ready: false, reasons: expect.arrayContaining(['model_relay_host_blocked']) })
    const metadataHost = { ...privateHost, MODEL_RELAY_BASE_URL: 'https://169.254.169.254/v1' }
    expect(evaluatePlatformModelGate(metadataHost, 'text')).toMatchObject({ ready: false })
    const credentialUrl = { ...privateHost, MODEL_RELAY_BASE_URL: 'https://user:secret@relay.example/v1' }
    expect(evaluatePlatformModelRelayGate(credentialUrl)).toMatchObject({ ready: false, reasons: expect.arrayContaining(['model_relay_endpoint_invalid']) })
    expect(evaluatePlatformModelGate(credentialUrl, 'text')).toMatchObject({ ready: false, reasons: expect.arrayContaining(['endpoint_invalid']) })
    // A public allowlisted relay keeps reporting ready.
    expect(evaluatePlatformModelGate({ ...privateHost, MODEL_RELAY_BASE_URL: 'https://relay.example/v1' }, 'text')).toMatchObject({ ready: false, reasons: ['relay_token_quota_monitor_unavailable'] })
  })

  it('reports OCR and video model readiness through the same relay gate', () => {
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay-key', OCR_MODEL: 'vision-v1' }, 'ocr')).toMatchObject({ ready: true, endpointHost: 'relay.example' })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay-key' }, 'video')).toMatchObject({ ready: false, reasons: ['model_missing'] })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', VIDEO_MODEL_RELAY_API_KEY: 'video-key', VIDEO_MODEL: 'video-v1' }, 'video')).toMatchObject({ ready: true, endpointHost: 'relay.example' })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay-key', IMAGE_MODEL: 'image-v1' }, 'image_edit')).toMatchObject({ ready: true, endpointHost: 'relay.example' })
  })

  it('treats whitespace-only primary model variables as missing for every modality', () => {
    const relay = { MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay-key' }
    expect(evaluatePlatformModelGate({ ...relay, AI_MODEL: '  ', MODEL_ID: 'text-v1' }, 'text')).toMatchObject({ ready: true })
    expect(evaluatePlatformModelGate({ ...relay, IMAGE_MODEL: '  ', AI_IMAGE_MODEL: 'image-v1' }, 'image')).toMatchObject({ ready: true })
    expect(evaluatePlatformModelGate({ ...relay, IMAGE_EDIT_MODEL: '  ', IMAGE_MODEL: '  ', AI_IMAGE_MODEL: 'image-v1' }, 'image_edit')).toMatchObject({ ready: true })
    expect(evaluatePlatformModelGate({ ...relay, OCR_MODEL: '  ', AI_VISION_MODEL: 'ocr-v1' }, 'ocr')).toMatchObject({ ready: true })
    expect(evaluatePlatformModelGate({ ...relay, VIDEO_MODEL: '  ', AI_VIDEO_MODEL: 'video-v1' }, 'video')).toMatchObject({ ready: true })
  })

  it('fails closed when image relay credentials or model ids are placeholders', () => {
    const result = evaluatePlatformModelGate({
      MODEL_RELAY_BASE_URL: 'https://relay.example',
      MODEL_RELAY_API_KEY: '${MODEL_RELAY_API_KEY}',
      IMAGE_MODEL: 'REPLACE_WITH_IMAGE_MODEL',
    }, 'image')
    expect(result).toMatchObject({ ready: false, reasons: expect.arrayContaining(['api_key_placeholder', 'model_placeholder']) })
  })
})
