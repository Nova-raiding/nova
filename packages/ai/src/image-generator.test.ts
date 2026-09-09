import { describe, expect, it } from 'vitest'
import { OpenAICompatibleImageGenerator, createImageGeneratorFromEnv } from './image-generator.js'
import { OpenAICompatibleImageEditGenerator, createImageEditGeneratorFromEnv } from './image-editor.js'

describe('image generator', () => {
  it('does not assemble an image edit provider from placeholder relay configuration', () => {
    expect(createImageEditGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: '${MODEL_RELAY_API_KEY}', IMAGE_EDIT_MODEL: 'REPLACE_WITH_IMAGE_EDIT_MODEL' })).toBeUndefined()
    expect(createImageEditGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'real-relay-key', IMAGE_EDIT_MODEL: 'your-image-edit-model' })).toBeUndefined()
  })

  it('queries provider status fail-closed and returns verified artifacts', async () => {
    let method = ''
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => { method = String(init?.method); return new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: { id: 'provider-1', status: 'completed', data: [{ url: 'https://cdn.example/one.png' }] } }), { status: 200 }) },
    })
    await expect(generator.queryStatus!('provider-1')).resolves.toMatchObject({ state: 'succeeded', providerRequestId: 'provider-1', images: ['https://cdn.example/one.png'], evidence: { source: 'provider_status', providerStatus: 'completed' } })
    expect(method).toBe('GET')
  })

  it('does not convert an unrecognized provider status into processing', async () => {
    const generator = new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async () => new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: { id: 'provider-1', status: 'new_protocol_state' } }), { status: 200 }) })
    await expect(generator.queryStatus!('provider-1')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', reconciliationRequired: true })
  })

  it('rejects a mismatched provider request id even when the provider reports failure', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: { id: 'provider-other', status: 'failed' } }), { status: 200 }),
    })
    await expect(generator.queryStatus!('provider-1')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', reconciliationRequired: true })
  })

  it('maps URL and base64 provider results into safe image references', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://image.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: [{ url: 'https://cdn.example/one.png' }, { b64_json: 'aGVsbG8=' }] }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 2 })).resolves.toEqual(['https://cdn.example/one.png', 'data:image/png;base64,aGVsbG8='])
  })

  it('reads multi-image choices and provider request id from the relay metadata envelope', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({
        data: [{ url: 'https://cdn.example/one.png' }],
        metadata: {
          request_id: 'provider-request-3',
          output: { choices: [
            { message: { content: [{ image: 'https://cdn.example/one.png' }] } },
            { message: { content: [{ image: 'https://cdn.example/two.png' }] } },
            { message: { content: [{ image: 'https://cdn.example/three.png' }] } },
          ] },
        },
      }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 3 })).resolves.toEqual([
      'https://cdn.example/one.png',
      'https://cdn.example/two.png',
      'https://cdn.example/three.png',
    ])
  })

  it('sends actual source pixels as multipart files to the edit endpoint', async () => {
    let endpoint = ''
    let body: FormData | undefined
    const generator = new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async (url, init) => {
      endpoint = String(url)
      body = init?.body as FormData
      expect(new Headers(init?.headers).has('content-type')).toBe(false)
      return new Response(JSON.stringify({ id: 'image-test-request', usage: { total_tokens: 2, cost_cny: 0.001 }, data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
    } })
    await generator.generate({ productTitle: '外套', direction: '白底', count: 1, mode: 'optimize', sourceAssetRefs: ['asset_source_1'], sourceImages: ['data:image/png;base64,AQID'] })
    expect(endpoint).toBe('https://relay.example/images/edits')
    expect(body?.get('prompt')).toEqual(expect.stringContaining('基于提供的已授权商品素材优化'))
    expect([...new Uint8Array(await (body?.get('image') as Blob).arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('rejects an optimize result that is byte-identical to the uploaded source', async () => {
    const source = 'data:image/png;base64,AQID'
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async () => new Response(JSON.stringify({ id: 'image-test-request', usage: { total_tokens: 2, cost_cny: 0.001 }, data: [{ b64_json: 'AQID' }] }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底主图', count: 1, mode: 'optimize', sourceImages: [source] }))
      .rejects.toMatchObject({ code: 'IMAGE_OUTPUT_UNCHANGED', providerOutcome: 'failed', retryable: false })
  })

  it('never downgrades an edit with only internal asset IDs to text-only generation', async () => {
    let called = false
    const generator = new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', fetch: async () => { called = true; throw new Error('unexpected') } })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 1, mode: 'optimize', sourceAssetRefs: ['asset_source_1'] })).rejects.toThrow('image optimize requires')
    expect(called).toBe(false)
  })

  it('injects platform DNA and confirmed SKU/marketing context without asking the model to invent copy', async () => {
    let requestBody: Record<string, unknown> | undefined
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
      },
    })
    await generator.generate({
      productTitle: '轻云防晒外套', direction: '功能卖点卡片 + 通勤场景', count: 1,
      visualBrief: {
        platform: 'taobao', placement: 'detail_page', skuLabels: ['蓝色/M', '黑色/L'],
        sellingPoints: ['轻量', '可拆帽'], headline: '轻装出行', subheadline: '通勤防护', cta: '立即了解',
        styleKeywords: ['品牌色点缀'],
        marketingLabels: ['会员价 ¥99.00', '立即查看'],
        competitorStructures: ['首屏商品占主体', '细节证据卡片'],
        competitorThemes: ['轻量通勤'],
        differentiationAngles: ['用真实参数替代泛化口号'],
      },
    })
    expect(requestBody?.prompt).toEqual(expect.stringContaining('淘宝风格默认'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('蓝色/M、黑色/L'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('轻量；可拆帽'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('营销版允许绘制上述已确认的短标题、短卖点、关键词、活动标签和 CTA'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('画面不要素白'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('会员价 ¥99.00'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('同平台同类竞品研究'))
  })

  it('turns confirmed marketing inputs into a designed main-image layer', async () => {
    let requestBody: Record<string, unknown> | undefined
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
      },
    })
    await generator.generate({
      productTitle: '浅蓝防雨冲锋衣', direction: '淘宝商品主图', count: 1,
      visualBrief: {
        platform: 'taobao', placement: '商品主图', sellingPoints: ['防雨'], trafficKeywords: ['冲锋衣', '通勤'],
        marketingLabels: ['防雨通勤'], promotionLabels: ['限时活动价 ¥99.00'], logoAssetIds: ['asset_brand_logo'], cta: '立即查看',
      },
    })
    expect(requestBody?.prompt).toContain('这是营销版商品主图')
    expect(requestBody?.prompt).toContain('品牌 Logo 已授权')
    expect(requestBody?.prompt).toContain('限时活动价 ¥99.00')
    expect(requestBody?.prompt).toContain('冲锋衣、通勤')
    expect(requestBody?.negative_prompt).not.toContain('中文文字')
    expect(requestBody?.negative_prompt).toContain('乱码')
  })

  it('turns a long-page request into an ordered conversion storyboard', async () => {
    let prompt = ''
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { prompt: string }
        prompt = body.prompt
        return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
      },
    })
    await generator.generate({ productTitle: '外套', direction: '详情长图', count: 1, visualBrief: { size: '1024x4096', outputVariant: 'detail_long', detailSections: ['首屏价值主张：商品与核心收益', '参数规格：尺寸与适配'], marketingLabels: ['活动价 ¥99.00'] } })
    expect(prompt).toContain('长图必须按以下连续章节完成')
    expect(prompt).toContain('首屏价值主张：商品与核心收益 → 参数规格：尺寸与适配')
    expect(prompt).toContain('严禁把多个正方形卡片简单纵向拼接')
    expect(prompt).toContain('活动价 ¥99.00')
  })

  it('uses a responsive conversion hierarchy for banners', async () => {
    let prompt = ''
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async (_url, init) => {
        prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt
        return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
      },
    })
    await generator.generate({ productTitle: '外套', direction: '夏季活动 Banner', count: 1, visualBrief: { platform: 'taobao', placement: '活动 Banner', outputVariant: 'banner', marketingLabels: ['活动价 ¥99.00', '立即抢购'] } })
    expect(prompt).toContain('槽位为电商 Banner/活动头图')
    expect(prompt).toContain('Banner 必须让商品、核心利益点和 CTA 在缩略图中仍可识别')
    expect(prompt).toContain('活动价 ¥99.00')
    expect(prompt).toContain('不得绘制未经确认的价格、折扣、销量、倒计时、平台 Logo 或二维码')
  })

  it('requires a newly rendered composition for a white-background main image', async () => {
    let requestBody: Record<string, unknown> | undefined
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
      },
    })
    await generator.generate({ productTitle: '外套', direction: '白底主图', count: 1, visualBrief: { platform: 'taobao', placement: '商品主图' } })
    expect(requestBody?.prompt).toEqual(expect.stringContaining('不得原样回传参考图像素'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('平台模板执行：模板=搜索首屏商品 hero'))
  })

  it('honors an explicit scene redesign request for a Taobao main image', async () => {
    let requestBody: Record<string, unknown> | undefined
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
      },
    })
    await generator.generate({ productTitle: '浅蓝色防晒外套', direction: '重新设计构图和户外通勤场景', count: 1, visualBrief: { platform: 'taobao', placement: '商品主图' } })
    expect(requestBody?.prompt).toEqual(expect.stringContaining('模板=场景型搜索首屏 hero'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('不能使用纯白/浅灰无缝背景'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('不能只放大、裁切、锐化或原样回传参考图'))
  })

  it('creates a responsive ecommerce banner brief without inventing promotional claims', async () => {
    let prompt = ''
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async (_url, init) => {
        prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt
        return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
      },
    })
    await generator.generate({ productTitle: '轻云防晒外套', direction: '活动头图', count: 1, visualBrief: { outputVariant: 'banner', marketingLabels: ['轻量通勤', '立即查看'] } })
    expect(prompt).toContain('槽位为电商 Banner/活动头图')
    expect(prompt).toContain('预留左右安全区和响应式裁切区')
    expect(prompt).toContain('不得绘制未经确认的价格、折扣、销量、倒计时、平台 Logo 或二维码')
    expect(prompt).toContain('轻量通勤｜立即查看')
  })

  it('only enables image generation through the HTTPS platform relay', () => {
    expect(createImageGeneratorFromEnv({ IMAGE_BASE_URL: 'https://image.example', IMAGE_MODEL: 'model' })).toBeUndefined()
    expect(createImageGeneratorFromEnv({ IMAGE_BASE_URL: 'https://image.example', IMAGE_API_KEY: 'key', IMAGE_MODEL: 'model' })).toBeUndefined()
    expect(createImageGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'http://relay.example', MODEL_RELAY_API_KEY: 'key', IMAGE_MODEL: 'model' })).toBeUndefined()
    expect(createImageGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'key', IMAGE_MODEL: 'model' })).toBeDefined()
  })

  it('does not assemble an image provider from placeholder relay configuration', () => {
    expect(createImageGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: '${MODEL_RELAY_API_KEY}', IMAGE_MODEL: 'REPLACE_WITH_IMAGE_MODEL' })).toBeUndefined()
    expect(createImageGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'real-relay-key', IMAGE_MODEL: 'your-image-model' })).toBeUndefined()
  })

  it('allows a provider-specific image path while rejecting absolute paths', async () => {
    let endpoint = ''
    const generator = new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }), path: '/v1/image/generate', fetch: async url => { endpoint = String(url); return new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 }) } })
    await generator.generate({ productTitle: '外套', direction: '白底', count: 1 })
    expect(endpoint).toBe('https://relay.example/v1/image/generate')
    expect(() => new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }), path: 'https://evil.example/generate' })).toThrow('safe relative path')
  })

  it('sends approved source image bytes to the relay image-to-image endpoint', async () => {
    let body: Record<string, unknown> | undefined
    let endpoint = ''
    const generator = new OpenAICompatibleImageEditGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'edit-model', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async (url, init) => { endpoint = String(url); body = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 }) } })
    await expect(generator.generate({ prompt: '优化背景', sourceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }], region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } })).resolves.toHaveLength(1)
    expect(endpoint).toBe('https://relay.example/images/generations')
    expect(body).toMatchObject({ image: ['data:image/png;base64,AQID'], image_mode: 'optimize', edit_region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, size: '1024x1024', response_format: 'url' })
  })

  it('rejects an oversized model relay response before parsing it', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://image.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response('{"data":[]}', { headers: { 'content-length': String(33 * 1024 * 1024) } }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 1 })).rejects.toThrow('safety limit')
  })

  it('uses a stable provider idempotency key and marks network ambiguity for reconciliation', async () => {
    const keys: string[] = []
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://image.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
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
      baseUrl: 'https://image.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: (async (_url, init) => {
        const headers = init?.headers as Record<string, string>
        key = headers['idempotency-key'] ?? ''
        return new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
      }) as typeof fetch,
    })
    await generator.generate({ productTitle: '外套', direction: '白底', count: 1 }, { providerOperationKey: 'image_provider_operation_reserved_1' })
    expect(key).toBe('image_provider_operation_reserved_1')
  })

  it('classifies a client-side image generation timeout as an unknown provider outcome', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }), timeoutMs: 1,
      fetch: ((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true })
      })) as typeof fetch,
    })
    const timeoutError = await generator.generate({ productTitle: '外套', direction: '白底', count: 1, usageContext: { actionId: 'image:request_timeout' } }).catch(error => error as Record<string, unknown>)
    expect(timeoutError).toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: true, providerOutcome: 'unknown', reconciliationRequired: true, retryable: false, providerIdempotencyKey: expect.stringMatching(/^model_provider_[a-f0-9]{64}$/u) })
  })

  it('aborts an in-flight relay request when the worker lease signal is cancelled', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }), timeoutMs: 60_000,
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
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response('invalid request', { status: 400 }),
    })
    const rejectionError = await generator.generate({ productTitle: '外套', direction: '白底', count: 1, usageContext: { actionId: 'image:request_rejected' } }).catch(error => error as Record<string, unknown>)
    expect(rejectionError).toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED', status: 400, providerSucceeded: false, providerOutcome: 'failed', reconciliationRequired: false, retryable: false, providerIdempotencyKey: expect.stringMatching(/^model_provider_[a-f0-9]{64}$/u) })
  })

  it('preserves the relay openai_error body instead of collapsing it into a generic error', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ error: { code: 'openai_error', type: 'upstream_capacity', message: 'selected image channel is unavailable' } }), { status: 502 }),
    })
    const error = await generator.generate({ productTitle: '外套', direction: '白底', count: 1 }).catch(reason => reason as Record<string, unknown>)
    expect(error).toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerOutcome: 'unknown', details: { provider_status: 502, provider_error_summary: 'openai_error: upstream_capacity: selected image channel is unavailable' } })
    expect(String((error as { message?: unknown })?.message)).toContain('openai_error')
  })

  it('surfaces an application error envelope returned with HTTP 200 as a failed provider request', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ error: { code: 'openai_error', message: 'model is not enabled' } }), { status: 200 }),
    })
    const error = await generator.generate({ productTitle: '外套', direction: '白底', count: 1 }).catch(reason => reason as Record<string, unknown>)
    expect(error).toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED', providerOutcome: 'failed', details: { provider_error_summary: 'openai_error: model is not enabled' } })
  })

  it('classifies an explicit provider timeout response as an unknown outcome', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response('gateway timeout', { status: 504 }),
    })
    const timeoutError = await generator.generate({ productTitle: '外套', direction: '白底', count: 1, usageContext: { actionId: 'image:request_504' } }).catch(error => error as Record<string, unknown>)
    expect(timeoutError).toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: true, providerOutcome: 'unknown', reconciliationRequired: true, retryable: false })
  })

  it('keeps an accepted but malformed image response pending reconciliation', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://image.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response('{not-json', { status: 200 }),
    })
    const error = await generator.generate({ productTitle: '外套', direction: '白底', count: 1, usageContext: { actionId: 'image:request_malformed' } }).catch(reason => reason as Record<string, unknown>)
    expect(error).toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: true, reconciliationRequired: true })
  })
})

it('preserves a per-job long page canvas in the real multipart edit request', async () => {
  const generator = new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'key', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async (_url, init) => {
    const body = init?.body as FormData
    expect(body.get('size')).toBe('1024x4096')
    expect(body.get('prompt')).toContain('完整商品详情页长图')
    return new Response(JSON.stringify({ id: 'long-page', usage: { total_tokens: 1, cost_cny: 0.01 }, data: [{ url: 'https://cdn.example/long.png' }] }))
  } })
  await generator.generate({ productTitle: '冲锋衣', direction: '六章节详情页', count: 1, mode: 'optimize', sourceImages: ['data:image/png;base64,AQID'], visualBrief: { size: '1024x4096' } })
})

it('sends Qwen native reference messages and long-page parameters through the configured relay', async () => {
  const source = 'data:image/png;base64,AQID'
  const generator = new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'key', model: 'qwen-image-2.0', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async (url, init) => {
    expect(url).toBe('https://relay.example/images/generations')
    const body = JSON.parse(init?.body as string)
    expect(body.parameters).toEqual({ size: '1024*4096', n: 1, watermark: false })
    expect(body.input.messages[0].content[0]).toEqual({ image: source })
    expect(body.input.messages[0].content[1].text).toContain('完整商品详情页长图')
    return new Response(JSON.stringify({ id: 'native-long', usage: { cost_cny: 0.01 }, data: [{ url: 'https://cdn.example/long.png' }] }))
  } })
  await generator.generate({ productTitle: '冲锋衣', direction: '六章节详情页', count: 1, mode: 'optimize', sourceImages: [source], visualBrief: { size: '1024x4096' } })
})
