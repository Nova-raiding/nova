import { describe, expect, it } from 'vitest'
import { OpenAICompatibleImageGenerator, createImageGeneratorFromEnv } from './image-generator.js'
import { OpenAICompatibleImageEditGenerator } from './image-editor.js'

describe('image generator', () => {
  it('queries provider status fail-closed and returns verified artifacts', async () => {
    let method = ''
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async (_url, init) => { method = String(init?.method); return new Response(JSON.stringify({ data: { id: 'provider-1', status: 'completed', data: [{ url: 'https://cdn.example/one.png' }] } }), { status: 200 }) },
    })
    await expect(generator.queryStatus!('provider-1')).resolves.toMatchObject({ state: 'succeeded', providerRequestId: 'provider-1', images: ['https://cdn.example/one.png'], evidence: { source: 'provider_status', providerStatus: 'completed' } })
    expect(method).toBe('GET')
  })

  it('does not convert an unrecognized provider status into processing', async () => {
    const generator = new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', fetch: async () => new Response(JSON.stringify({ data: { id: 'provider-1', status: 'new_protocol_state' } }), { status: 200 }) })
    await expect(generator.queryStatus!('provider-1')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', reconciliationRequired: true })
  })

  it('rejects a mismatched provider request id even when the provider reports failure', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async () => new Response(JSON.stringify({ data: { id: 'provider-other', status: 'failed' } }), { status: 200 }),
    })
    await expect(generator.queryStatus!('provider-1')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', reconciliationRequired: true })
  })

  it('maps URL and base64 provider results into safe image references', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://image.example', apiKey: 'secret', model: 'image-model',
      fetch: async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/one.png' }, { b64_json: 'aGVsbG8=' }] }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 2 })).resolves.toEqual(['https://cdn.example/one.png', 'data:image/png;base64,aGVsbG8='])
  })

  it('passes workspace-scoped source asset references to the model relay', async () => {
    let requestBody: Record<string, unknown> | undefined
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
      },
    })
    await generator.generate({ productTitle: '外套', direction: '白底', count: 1, mode: 'optimize', sourceAssetRefs: ['asset_source_1'] })
    expect(requestBody).toMatchObject({ source_asset_refs: ['asset_source_1'], image_mode: 'optimize', prompt: expect.stringContaining('基于提供的已授权商品素材优化') })
  })

  it('injects platform DNA and confirmed SKU/marketing context without asking the model to invent copy', async () => {
    let requestBody: Record<string, unknown> | undefined
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
      },
    })
    await generator.generate({
      productTitle: '轻云防晒外套', direction: '功能卖点卡片 + 通勤场景', count: 1,
      visualBrief: {
        platform: 'taobao', placement: 'detail_page', skuLabels: ['蓝色/M', '黑色/L'],
        sellingPoints: ['轻量', '可拆帽'], headline: '轻装出行', subheadline: '通勤防护', cta: '立即了解',
        styleKeywords: ['品牌色点缀'],
      },
    })
    expect(requestBody?.prompt).toEqual(expect.stringContaining('淘宝风格默认'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('蓝色/M、黑色/L'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('轻量；可拆帽'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('中文长文案和精确事实文字不要交给模型直接绘制'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('画面不要素白'))
  })

  it('only enables image generation through the HTTPS platform relay', () => {
    expect(createImageGeneratorFromEnv({ IMAGE_BASE_URL: 'https://image.example', IMAGE_MODEL: 'model' })).toBeUndefined()
    expect(createImageGeneratorFromEnv({ IMAGE_BASE_URL: 'https://image.example', IMAGE_API_KEY: 'key', IMAGE_MODEL: 'model' })).toBeUndefined()
    expect(createImageGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'http://relay.example', MODEL_RELAY_API_KEY: 'key', IMAGE_MODEL: 'model' })).toBeUndefined()
    expect(createImageGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'key', IMAGE_MODEL: 'model' })).toBeDefined()
  })

  it('allows a provider-specific image path while rejecting absolute paths', async () => {
    let endpoint = ''
    const generator = new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', path: '/v1/image/generate', fetch: async url => { endpoint = String(url); return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 }) } })
    await generator.generate({ productTitle: '外套', direction: '白底', count: 1 })
    expect(endpoint).toBe('https://relay.example/v1/image/generate')
    expect(() => new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', path: 'https://evil.example/generate' })).toThrow('safe relative path')
  })

  it('sends approved source image bytes to the relay image-to-image endpoint', async () => {
    let body: Record<string, unknown> | undefined
    let endpoint = ''
    const generator = new OpenAICompatibleImageEditGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'edit-model', fetch: async (url, init) => { endpoint = String(url); body = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 }) } })
    await expect(generator.generate({ prompt: '优化背景', sourceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }], region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } })).resolves.toHaveLength(1)
    expect(endpoint).toBe('https://relay.example/images/generations')
    expect(body).toMatchObject({ image: ['data:image/png;base64,AQID'], image_mode: 'optimize', edit_region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, size: '1024x1024', response_format: 'url' })
  })

  it('rejects an oversized model relay response before parsing it', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://image.example', apiKey: 'secret', model: 'image-model',
      fetch: async () => new Response('{"data":[]}', { headers: { 'content-length': String(33 * 1024 * 1024) } }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 1 })).rejects.toThrow('safety limit')
  })

  it('uses a stable provider idempotency key and marks network ambiguity for reconciliation', async () => {
    const keys: string[] = []
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://image.example', apiKey: 'secret', model: 'image-model',
      fetch: (async (_url, init) => {
        const headers = init?.headers as (Record<string, string> & { get?: (name: string) => string | null }) | undefined
        keys.push(headers?.['idempotency-key'] ?? headers?.get?.('idempotency-key') ?? '')
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    const input = { productTitle: '外套', direction: '白底', count: 1, usageContext: { workspaceId: 'ws_1', actionId: 'image:request_1' } }
    const first = await generator.generate(input).catch(error => error as Record<string, unknown>)
    const second = await generator.generate(input).catch(error => error as Record<string, unknown>)
    await generator.generate({ ...input, usageContext: { ...input.usageContext, workspaceId: 'ws_2' } }).catch(() => undefined)
    expect(keys).toHaveLength(3)
    expect(keys[0]).toMatch(/^model_provider_[a-f0-9]{64}$/u)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
    expect(first).toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: true, providerOutcome: 'unknown', reconciliationRequired: true, retryable: false, providerIdempotencyKey: keys[0], details: { provider_succeeded: true, provider_outcome: 'unknown', reconciliation_required: true, provider_idempotency_key: keys[0] } })
    expect(second).toMatchObject({ providerIdempotencyKey: keys[0] })
  })

  it('uses the durable provider operation reservation verbatim', async () => {
    let key = ''
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://image.example', apiKey: 'secret', model: 'image-model',
      fetch: (async (_url, init) => {
        const headers = init?.headers as Record<string, string>
        key = headers['idempotency-key'] ?? ''
        return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
      }) as typeof fetch,
    })
    await generator.generate({ productTitle: '外套', direction: '白底', count: 1 }, { providerOperationKey: 'image_provider_operation_reserved_1' })
    expect(key).toBe('image_provider_operation_reserved_1')
  })

  it('classifies a client-side image generation timeout as an unknown provider outcome', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', timeoutMs: 1,
      fetch: ((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true })
      })) as typeof fetch,
    })
    const timeoutError = await generator.generate({ productTitle: '外套', direction: '白底', count: 1, usageContext: { actionId: 'image:request_timeout' } }).catch(error => error as Record<string, unknown>)
    expect(timeoutError).toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: true, providerOutcome: 'unknown', reconciliationRequired: true, retryable: false, providerIdempotencyKey: expect.stringMatching(/^model_provider_[a-f0-9]{64}$/u) })
  })

  it('aborts an in-flight relay request when the worker lease signal is cancelled', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', timeoutMs: 60_000,
      fetch: ((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('lease lost', 'AbortError')), { once: true })
      })) as typeof fetch,
    })
    const controller = new AbortController()
    const pending = generator.generate({ productTitle: '外套', direction: '白底', count: 1, usageContext: { actionId: 'image:lease_lost' } }, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: true, reconciliationRequired: true })
  })

  it('classifies an explicit image provider rejection as failed', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async () => new Response('invalid request', { status: 400 }),
    })
    const rejectionError = await generator.generate({ productTitle: '外套', direction: '白底', count: 1, usageContext: { actionId: 'image:request_rejected' } }).catch(error => error as Record<string, unknown>)
    expect(rejectionError).toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED', status: 400, providerSucceeded: false, providerOutcome: 'failed', reconciliationRequired: false, retryable: false, providerIdempotencyKey: expect.stringMatching(/^model_provider_[a-f0-9]{64}$/u) })
  })

  it('classifies an explicit provider timeout response as an unknown outcome', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async () => new Response('gateway timeout', { status: 504 }),
    })
    const timeoutError = await generator.generate({ productTitle: '外套', direction: '白底', count: 1, usageContext: { actionId: 'image:request_504' } }).catch(error => error as Record<string, unknown>)
    expect(timeoutError).toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: true, providerOutcome: 'unknown', reconciliationRequired: true, retryable: false })
  })

  it('keeps an accepted but malformed image response pending reconciliation', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://image.example', apiKey: 'secret', model: 'image-model',
      fetch: async () => new Response('{not-json', { status: 200 }),
    })
    const error = await generator.generate({ productTitle: '外套', direction: '白底', count: 1, usageContext: { actionId: 'image:request_malformed' } }).catch(reason => reason as Record<string, unknown>)
    expect(error).toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: true, reconciliationRequired: true })
  })
})
