import { describe, expect, it } from 'vitest'
import { createVideoGeneratorFromEnv, OpenAICompatibleVideoGenerator, validateVideoRelayPath, videoDurationSeconds } from './video-generator.js'

describe('video generator relay', () => {
  it('rejects unsafe configurable relay paths', () => {
    expect(() => validateVideoRelayPath('https://evil.example/video', 'generation')).toThrow('safe relative path')
    expect(() => validateVideoRelayPath('/video/{other}', 'status')).toThrow('unsupported placeholder')
    expect(validateVideoRelayPath('/video/generations/{job_id}', 'status')).toBe('/video/generations/{job_id}')
  })
  it('uses the platform relay and accepts a completed HTTPS artifact', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) })
        return new Response(JSON.stringify({ data: { id: 'vid_1', video_url: 'https://cdn.example/video.mp4' } }), { status: 200 })
      }) as typeof fetch,
    })
    await expect(generator.generate({ prompt: '生成春季上新短视频', output: 'rendering', context: { product: { id: 'p1' } } })).resolves.toEqual({ status: 'completed', videoUrl: 'https://cdn.example/video.mp4', providerJobId: 'vid_1' })
    expect(calls[0]?.url).toBe('https://relay.example/video/generations')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ model: 'video-v1', prompt: '生成春季上新短视频', duration: 5 })
  })

  it('accepts an opaque queued provider job but rejects non-HTTPS artifacts', async () => {
    const queued = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async () => new Response(JSON.stringify({ task_id: 'job_1', status: 'queued' }), { status: 200 })) as typeof fetch,
    })
    await expect(queued.generate({ prompt: '生成视频', output: 'rendering', context: {} })).resolves.toEqual({ status: 'queued', providerJobId: 'job_1' })

    const invalid = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async () => new Response(JSON.stringify({ url: 'http://cdn.example/video.mp4' }), { status: 200 })) as typeof fetch,
    })
    await expect(invalid.generate({ prompt: '生成视频', output: 'rendering', context: {} })).rejects.toThrow('neither an HTTPS artifact URL nor a provider job id')
  })

  it('queries an opaque provider job without charging the wallet again', async () => {
    let method = ''
    let url = ''
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async (input, init) => { url = String(input); method = init?.method ?? ''; return new Response(JSON.stringify({ data: { task_id: 'job_1', status: 'completed', output_url: 'https://cdn.example/video.mp4' } }), { status: 200 }) }) as typeof fetch,
    })
    await expect(generator.getStatus('job_1')).resolves.toEqual({ status: 'completed', videoUrl: 'https://cdn.example/video.mp4', providerJobId: 'job_1' })
    expect(method).toBe('GET')
    expect(url).toBe('https://relay.example/video/generations/job_1')
  })

  it('accepts the relay nested SUCCESS schema only when it contains an HTTPS artifact', async () => {
    const nested = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async () => new Response(JSON.stringify({ code: 0, message: 'ok', data: { task_id: 'job_nested', status: 'SUCCESS', result_url: 'https://cdn.example/result.mp4', quota: 123, data: { output: { url: 'https://cdn.example/output.mp4' }, request_id: 'request_nested', usage: { duration_seconds: 5 } } } }), { status: 200 })) as typeof fetch,
    })
    await expect(nested.getStatus('job_nested')).resolves.toEqual({ status: 'completed', videoUrl: 'https://cdn.example/result.mp4', providerJobId: 'job_nested' })

    const unsafe = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async () => new Response(JSON.stringify({ data: { task_id: 'job_nested', status: 'SUCCESS', result_url: 'http://cdn.example/result.mp4', data: { output: 'javascript:alert(1)' } } }), { status: 200 })) as typeof fetch,
    })
    await expect(unsafe.getStatus('job_nested')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' })

    const rejected = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async () => new Response(JSON.stringify({ code: 5001, message: 'failed', data: { task_id: 'job_nested', status: 'SUCCESS', result_url: 'https://cdn.example/stale.mp4' } }), { status: 200 })) as typeof fetch,
    })
    await expect(rejected.getStatus('job_nested')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED', providerOutcome: 'failed' })
  })

  it('does not trust a completed status without an HTTPS artifact', async () => {
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async () => new Response(JSON.stringify({ data: { id: 'job_1', status: 'completed' } }), { status: 200 })) as typeof fetch,
    })
    await expect(generator.getStatus('job_1')).rejects.toThrow('completed without an HTTPS artifact URL')
  })

  it('requires the HTTPS platform relay in every environment', () => {
    expect(createVideoGeneratorFromEnv({ VIDEO_BASE_URL: 'https://direct.example', VIDEO_API_KEY: 'direct', VIDEO_MODEL: 'v1' })).toBeUndefined()
    expect(createVideoGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'http://relay.example', MODEL_RELAY_API_KEY: 'relay', VIDEO_MODEL: 'v1' })).toBeUndefined()
    expect(createVideoGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay', VIDEO_MODEL: 'v1' })).toBeDefined()
    expect(createVideoGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', VIDEO_MODEL_RELAY_API_KEY: 'video-relay', VIDEO_MODEL: 'v1' })).toBeDefined()
  })

  it('passes a bounded configurable duration required by per-duration relay billing', async () => {
    let body: Record<string, unknown> = {}
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay', model: 'v1', durationSeconds: 12,
      fetch: (async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ task_id: 'job_1', status: 'queued' }), { status: 200 })
      }) as typeof fetch,
    })
    await generator.generate({ prompt: '生成视频', output: 'rendering', context: {} })
    expect(body.duration).toBe(12)
  })

  it('accepts the configured 100-second maximum without exceeding it', () => {
    expect(videoDurationSeconds('100')).toBe(100)
    expect(videoDurationSeconds('101')).toBe(100)
  })

  it('reuses a stable provider key and exposes timeout ambiguity to the server', async () => {
    const keys: string[] = []
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay', model: 'v1',
      fetch: (async (_url, init) => {
        keys.push(new Headers(init?.headers).get('idempotency-key') ?? '')
        throw new DOMException('timed out', 'AbortError')
      }) as typeof fetch,
    })
    const input = { prompt: '生成视频', output: 'rendering' as const, context: {}, usageContext: { workspaceId: 'ws_1', actionId: 'video:request_1' } }
    const first = await generator.generate(input).catch(error => error as Record<string, unknown>)
    const second = await generator.generate(input).catch(error => error as Record<string, unknown>)
    await generator.generate({ ...input, usageContext: { ...input.usageContext, workspaceId: 'ws_2' } }).catch(error => error as Record<string, unknown>)
    expect(keys[0]).toMatch(/^model_provider_[a-f0-9]{64}$/u)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
    expect(first).toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: true, providerOutcome: 'unknown', reconciliationRequired: true, retryable: false, providerIdempotencyKey: keys[0] })
    expect(second).toMatchObject({ providerIdempotencyKey: keys[0] })
  })

  it('keeps an explicit non-timeout provider response distinguishable from unknown outcome', async () => {
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay', model: 'v1',
      fetch: (async () => new Response('invalid request', { status: 422 })) as typeof fetch,
    })
    const error = await generator.generate({ prompt: '生成视频', output: 'rendering', context: {}, usageContext: { actionId: 'video:request_2' } }).catch(reason => reason as Record<string, unknown>)
    expect(error).toMatchObject({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
      status: 422,
      providerSucceeded: false,
      providerOutcome: 'failed',
      reconciliationRequired: false,
      retryable: false,
      providerIdempotencyKey: expect.stringMatching(/^model_provider_[a-f0-9]{64}$/u),
      details: {
        provider_succeeded: false,
        provider_outcome: 'failed',
        reconciliation_required: false,
        provider_idempotency_key: expect.stringMatching(/^model_provider_[a-f0-9]{64}$/u),
        provider_status: 422,
      },
    })
  })

  it('classifies an accepted provider job with an explicit failed status as failed, not unknown', async () => {
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay', model: 'v1',
      fetch: (async () => new Response(JSON.stringify({ task_id: 'job_failed', status: 'failed' }), { status: 200 })) as typeof fetch,
    })
    const error = await generator.generate({ prompt: '生成视频', output: 'rendering', context: {}, usageContext: { actionId: 'video:request_failed' } }).catch(reason => reason as Record<string, unknown>)
    expect(error).toMatchObject({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
      status: 200,
      providerSucceeded: false,
      providerOutcome: 'failed',
      reconciliationRequired: false,
      retryable: false,
      details: { provider_outcome: 'failed', provider_status: 200 },
    })
  })

  it('treats an explicit gateway timeout as an unknown provider outcome', async () => {
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay', model: 'v1',
      fetch: (async () => new Response('gateway timeout', { status: 504 })) as typeof fetch,
    })
    const error = await generator.generate({ prompt: '生成视频', output: 'rendering', context: {}, usageContext: { actionId: 'video:request_timeout' } }).catch(reason => reason as Record<string, unknown>)
    expect(error).toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: true, providerOutcome: 'unknown', reconciliationRequired: true, retryable: false })
  })
})
