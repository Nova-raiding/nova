import { describe, expect, it } from 'vitest'
import { createVideoGeneratorFromEnv, OpenAICompatibleVideoGenerator, validateVideoRelayPath, videoDurationSeconds } from './video-generator.js'

describe('video generator relay', () => {
  it('does not assemble a video provider from placeholder relay configuration', () => {
    expect(createVideoGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: '${MODEL_RELAY_API_KEY}', VIDEO_MODEL: 'REPLACE_WITH_VIDEO_MODEL' })).toBeUndefined()
    expect(createVideoGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'real-relay-key', VIDEO_MODEL: 'your-video-model' })).toBeUndefined()
  })

  it('rejects unsafe configurable relay paths', () => {
    expect(() => validateVideoRelayPath('https://evil.example/video', 'generation')).toThrow('safe relative path')
    expect(() => validateVideoRelayPath('/video/{other}', 'status')).toThrow('unsupported placeholder')
    expect(validateVideoRelayPath('/video/generations/{job_id}', 'status')).toBe('/video/generations/{job_id}')
  })
  it('uses the platform relay and accepts a completed HTTPS artifact', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) })
        return new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: { id: 'vid_1', video_url: 'https://cdn.example/video.mp4' } }), { status: 200 })
      }) as typeof fetch,
    })
    await expect(generator.generate({ prompt: '生成春季上新短视频', output: 'rendering', context: { product: { id: 'p1' } } })).resolves.toEqual({ status: 'completed', videoUrl: 'https://cdn.example/video.mp4', providerJobId: 'vid_1' })
    expect(calls[0]?.url).toBe('https://relay.example/video/generations')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ model: 'video-v1', prompt: '生成春季上新短视频', duration: 5 })
  })

  it('accepts an opaque queued provider job but rejects non-HTTPS artifacts', async () => {
    const queued = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, task_id: 'job_1', status: 'queued' }), { status: 200 })) as typeof fetch,
    })
    await expect(queued.generate({ prompt: '生成视频', output: 'rendering', context: {} })).resolves.toEqual({ status: 'queued', providerJobId: 'job_1' })

    const invalid = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, url: 'http://cdn.example/video.mp4' }), { status: 200 })) as typeof fetch,
    })
    await expect(invalid.generate({ prompt: '生成视频', output: 'rendering', context: {} })).rejects.toThrow('neither an HTTPS artifact URL nor a provider job id')
  })

  it('queries an opaque provider job without charging the wallet again', async () => {
    let method = ''
    let url = ''
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async (input, init) => { url = String(input); method = init?.method ?? ''; return new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: { task_id: 'job_1', status: 'completed', output_url: 'https://cdn.example/video.mp4' } }), { status: 200 }) }) as typeof fetch,
    })
    await expect(generator.getStatus('job_1')).resolves.toEqual({ status: 'completed', videoUrl: 'https://cdn.example/video.mp4', providerJobId: 'job_1' })
    expect(method).toBe('GET')
    expect(url).toBe('https://relay.example/video/generations/job_1')
  })

  it('accepts the relay nested SUCCESS schema only when it contains an HTTPS artifact', async () => {
    const nested = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, code: 0, message: 'ok', data: { task_id: 'job_nested', status: 'SUCCESS', result_url: 'https://cdn.example/result.mp4', quota: 123, data: { output: { url: 'https://cdn.example/output.mp4' }, request_id: 'request_nested', usage: { duration_seconds: 5 } } } }), { status: 200 })) as typeof fetch,
    })
    await expect(nested.getStatus('job_nested')).resolves.toEqual({ status: 'completed', videoUrl: 'https://cdn.example/result.mp4', providerJobId: 'job_nested' })

    const unsafe = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: { task_id: 'job_nested', status: 'SUCCESS', result_url: 'http://cdn.example/result.mp4', data: { output: 'javascript:alert(1)' } } }), { status: 200 })) as typeof fetch,
    })
    await expect(unsafe.getStatus('job_nested')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' })

    const rejected = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, code: 5001, message: 'failed', data: { task_id: 'job_nested', status: 'SUCCESS', result_url: 'https://cdn.example/stale.mp4' } }), { status: 200 })) as typeof fetch,
    })
    await expect(rejected.getStatus('job_nested')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED', providerOutcome: 'failed' })
  })

  it('accepts New API string success envelopes while a video job is in progress', async () => {
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async () => new Response(JSON.stringify({ code: 'success', data: { task_id: 'job_new_api', status: 'IN_PROGRESS', progress: '30%' } }), { status: 200 })) as typeof fetch,
    })
    await expect(generator.getStatus('job_new_api')).resolves.toEqual({ status: 'queued', providerJobId: 'job_new_api' })
  })

  it('does not trust a completed status without an HTTPS artifact', async () => {
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: { id: 'job_1', status: 'completed' } }), { status: 200 })) as typeof fetch,
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
      baseUrl: 'https://relay.example', apiKey: 'relay', model: 'v1', usageSink: () => ({ recorded: true, costEvidence: true }), durationSeconds: 12,
      fetch: (async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, task_id: 'job_1', status: 'queued' }), { status: 200 })
      }) as typeof fetch,
    })
    await generator.generate({ prompt: '生成视频', output: 'rendering', context: {} })
    expect(body.duration).toBe(12)
  })

  it.each([
    [-1, 3],
    [12.9, 12],
    [99, 15],
    [Number.NaN, 5],
  ] as const)('normalizes direct duration %s before request and usage settlement', async (configured, expected) => {
    let body: Record<string, unknown> = {}
    let usageMetadata: Record<string, unknown> | undefined
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay', model: 'v1', durationSeconds: configured,
      usageSink: record => { usageMetadata = record.metadata; return { recorded: true, costEvidence: true } },
      fetch: (async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, task_id: 'job_1', status: 'queued' }), { status: 200 })
      }) as typeof fetch,
    })
    await generator.generate({ prompt: '生成视频', output: 'rendering', context: {} })
    expect(body.duration).toBe(expected)
    expect(usageMetadata).toMatchObject({ duration_seconds: expected })
  })

  it('accepts the configured 100-second maximum without exceeding it', () => {
    expect(videoDurationSeconds('1')).toBe(3)
    expect(videoDurationSeconds('15')).toBe(15)
    expect(videoDurationSeconds('100')).toBe(15)
  })

  it('reuses a stable provider key and exposes timeout ambiguity to the server', async () => {
    const keys: string[] = []
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay', model: 'v1', usageSink: () => ({ recorded: true, costEvidence: true }),
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
      baseUrl: 'https://relay.example', apiKey: 'relay', model: 'v1', usageSink: () => ({ recorded: true, costEvidence: true }),
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
      baseUrl: 'https://relay.example', apiKey: 'relay', model: 'v1', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, task_id: 'job_failed', status: 'failed' }), { status: 200 })) as typeof fetch,
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
      baseUrl: 'https://relay.example', apiKey: 'relay', model: 'v1', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async () => new Response('gateway timeout', { status: 504 })) as typeof fetch,
    })
    const error = await generator.generate({ prompt: '生成视频', output: 'rendering', context: {}, usageContext: { actionId: 'video:request_timeout' } }).catch(reason => reason as Record<string, unknown>)
    expect(error).toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: true, providerOutcome: 'unknown', reconciliationRequired: true, retryable: false })
  })
})


describe('reference-conditioned video', () => {
  it('transmits source pixels using the configured image-to-video model', async () => {
    let payload: Record<string, unknown> = {}
    const generator = new OpenAICompatibleVideoGenerator({ baseUrl: 'https://relay.example', apiKey: 'key', model: 'text-model', imageModel: 'image-model', resolution: '1080P', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async (_url, init) => {
      payload = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ usage: { total_tokens: 1, cost_cny: 0.01 }, task_id: 'test-video', status: 'queued' }))
    } })
    await generator.generate({ prompt: '轻微推近', output: 'rendering', context: {}, sourceImage: 'data:image/png;base64,AQID' })
    expect(payload).toMatchObject({ model: 'image-model', image: 'data:image/png;base64,AQID', duration: 5, size: '1080P', metadata: { parameters: { resolution: '1080P' } } })
  })
  it('does not silently use text-to-video when reference capability is missing', async () => {
    const generator = new OpenAICompatibleVideoGenerator({ baseUrl: 'https://relay.example', apiKey: 'key', model: 'text-model', fetch: async () => { throw new Error('must not request') } })
    await expect(generator.generate({ prompt: '商品', output: 'rendering', context: {}, sourceImage: 'data:image/png;base64,AQID' })).rejects.toThrow('VIDEO_IMAGE_MODEL_REQUIRED')
  })
})


describe('video rejection evidence', () => {
  it('preserves relay parameter errors and request ids without claiming an unknown outcome', async () => {
    const generator = new OpenAICompatibleVideoGenerator({ baseUrl: 'https://relay.example', apiKey: 'key', model: 'video', fetch: async () => new Response(JSON.stringify({ error: { code: 'invalid_parameter', message: 'image is required' } }), { status: 400, headers: { 'x-request-id': 'video-rejected-1' } }) })
    await expect(generator.generate({ prompt: '商品', output: 'rendering', context: {} })).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED', details: { provider_status: 400, provider_request_id: 'video-rejected-1', provider_error_summary: 'invalid_parameter: image is required', reconciliation_required: false } })
  })
})


it('sends HappyHorse native first-frame media through the relay metadata adapter', async () => {
  let payload: any
  const generator = new OpenAICompatibleVideoGenerator({ baseUrl: 'https://relay.example', apiKey: 'key', model: 'text-model', imageModel: 'happyhorse-1.1-i2v', resolution: '1080P', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async (_url, init) => {
    payload = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ usage: { total_tokens: 1, cost_cny: 0.01 }, task_id: 'native-i2v', status: 'queued' }))
  } })
  await generator.generate({ prompt: '商品', output: 'rendering', context: {}, sourceImage: 'data:image/png;base64,AQID' })
  expect(payload.metadata).toEqual({ parameters: { resolution: '1080P' }, input: { media: [{ type: 'first_frame', url: 'data:image/png;base64,AQID' }] } })
})


it('sends real reference file bytes in the OpenAI video multipart protocol', async () => {
  let body: FormData | undefined
  const generator = new OpenAICompatibleVideoGenerator({ baseUrl: 'https://relay.example', apiKey: 'key', model: 'wan3.0-video', imageModel: 'wan3.0-video', resolution: '1080P', requestFormat: 'openai-video', path: '/videos', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async (url, init) => {
    expect(String(url)).toBe('https://relay.example/videos')
    expect(new Headers(init?.headers).has('content-type')).toBe(false)
    body = init?.body as FormData
    return new Response(JSON.stringify({ usage: { total_tokens: 1, cost_cny: 0.01 }, id: 'multipart-video', status: 'queued' }))
  } })
  await generator.generate({ prompt: '商品展示', output: 'rendering', context: {}, sourceImage: 'data:image/png;base64,AQID' })
  expect(body?.get('seconds')).toBe('5')
  expect(body?.get('size')).toBe('1080P')
  const file = body?.get('input_reference') as Blob
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3])
  expect(file.type).toBe('image/png')
})

it('passes Wan 3 original image as native first-frame media, never text-only', async () => {
  let payload: any
  const generator = new OpenAICompatibleVideoGenerator({ baseUrl: 'https://relay.example', apiKey: 'key', model: 'wan3.0-video', imageModel: 'wan3.0-video', resolution: '1080P', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async (_url, init) => {
    payload = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ usage: { total_tokens: 1, cost_cny: 0.01 }, task_id: 'wan-original', status: 'queued' }))
  } })
  await generator.generate({ prompt: '商品', output: 'rendering', context: {}, sourceImage: 'data:image/png;base64,AQID' })
  expect(payload.metadata.input.media).toEqual([{ type: 'first_frame', url: 'data:image/png;base64,AQID' }])
  expect(payload.image).toBe('data:image/png;base64,AQID')
})
