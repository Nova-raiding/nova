import { describe, expect, it, vi } from 'vitest'
import { deflateSync } from 'node:zlib'
import { OpenAICompatibleImageGenerator, createImageGeneratorFromEnv } from './image-generator.js'
import { OpenAICompatibleImageEditGenerator, createImageEditGeneratorFromEnv } from './image-editor.js'
import type { RelayUsageRecord } from './relay-usage.js'

const VALID_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function solidWhitePng(size = 64) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const chunk = (type: string, body: Buffer) => {
    const header = Buffer.alloc(8); header.writeUInt32BE(body.length, 0); header.write(type, 4, 'ascii')
    return Buffer.concat([header, body, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 255)])
  const pixels = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}

describe('image generator', () => {
  it('does not assemble an image edit provider from placeholder relay configuration', () => {
    expect(createImageEditGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: '${MODEL_RELAY_API_KEY}', IMAGE_EDIT_MODEL: 'REPLACE_WITH_IMAGE_EDIT_MODEL' })).toBeUndefined()
    expect(createImageEditGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'real-relay-key', IMAGE_EDIT_MODEL: 'your-image-edit-model' })).toBeUndefined()
  })

  it('never assembles an image edit provider whose timeout would abort every edit', () => {
    const relay = { MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'real-relay-key', IMAGE_EDIT_MODEL: 'edit-model' }
    expect(createImageEditGeneratorFromEnv({ ...relay, IMAGE_EDIT_TIMEOUT_MS: '300s' })).toBeUndefined()
    expect(createImageEditGeneratorFromEnv({ ...relay, IMAGE_EDIT_TIMEOUT_MS: '300000' })).toBeDefined()
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
      fetch: async () => new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, output_image_count: 2, cost_cny: 0.001 }, data: [{ url: 'https://cdn.example/one.png' }, { b64_json: 'aGVsbG8=' }] }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 2 })).resolves.toEqual(['https://cdn.example/one.png', 'data:image/png;base64,aGVsbG8='])
  })

  it('maps the New API nested image envelope into image references', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ data: { request_id: 'nested-image-request', data: [{ url: 'https://cdn.example/nested.png' }] }, usage: { output_image_count: 1, cost_cny: 0.01 } }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 1 })).resolves.toEqual(['https://cdn.example/nested.png'])
  })

  it('reads multi-image choices and provider request id from the relay metadata envelope', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({
        data: [{ url: 'https://cdn.example/one.png' }],
        usage: { output_image_count: 3 },
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

  it('settles a New API Qwen image response from its preserved provider image_count', async () => {
    const sink = vi.fn<(record: RelayUsageRecord) => { recorded: true; costEvidence: true }>(() => ({ recorded: true, costEvidence: true }))
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'qwen-image-2.0', usageSink: sink,
      fetch: async () => new Response(JSON.stringify({
        data: [{ url: 'https://cdn.example/qwen.png' }],
        metadata: {
          request_id: 'qwen-provider-request',
          usage: { image_count: 1, height: 1024, width: 1024 },
          output: { choices: [{ message: { content: [{ image: 'https://cdn.example/qwen.png' }] } }] },
        },
      }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 1 })).resolves.toEqual(['https://cdn.example/qwen.png'])
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      providerRequestId: 'qwen-provider-request',
      metadata: expect.objectContaining({ usage_observed: true, billing_units: 1, billing_units_evidence: 'provider_usage' }),
    }))
  })

  it('sends actual source pixels as multipart files to the edit endpoint', async () => {
    let endpoint = ''
    let body: FormData | undefined
    const generator = new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async (url, init) => {
      endpoint = String(url)
      body = init?.body as FormData
      expect(new Headers(init?.headers).has('content-type')).toBe(false)
      return new Response(JSON.stringify({ id: 'image-test-request', usage: { total_tokens: 2, output_image_count: 1, cost_cny: 0.001 }, data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
    } })
    await generator.generate({ productTitle: '外套', direction: '白底', count: 1, mode: 'optimize', sourceAssetRefs: ['asset_source_1'], sourceImages: ['data:image/png;base64,AQID'] })
    expect(endpoint).toBe('https://relay.example/images/edits')
    expect(body?.get('prompt')).toEqual(expect.stringContaining('基于提供的已授权商品素材优化'))
    expect([...new Uint8Array(await (body?.get('image') as Blob).arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('rejects an optimize result that is byte-identical to the uploaded source', async () => {
    const source = 'data:image/png;base64,AQID'
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ id: 'image-test-request', usage: { total_tokens: 2, output_image_count: 1, cost_cny: 0.001 }, data: [{ b64_json: 'AQID' }] }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底主图', count: 1, mode: 'optimize', sourceImages: [source] }))
      .rejects.toMatchObject({ code: 'IMAGE_OUTPUT_UNCHANGED', providerOutcome: 'failed', retryable: false })
  })

  it('rejects an almost-empty white inline artifact after recording relay usage', async () => {
    const sink = vi.fn<(record: RelayUsageRecord) => { recorded: true; costEvidence: true }>(() => ({ recorded: true, costEvidence: true }))
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: sink,
      fetch: async () => new Response(JSON.stringify({ id: 'white-image', usage: { output_image_count: 1, cost_cny: 0.01 }, data: [{ b64_json: solidWhitePng() }] }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底主图', count: 1, visualBrief: { marketingLabels: ['新品'] } })).rejects.toMatchObject({ code: 'IMAGE_ARTIFACT_QUALITY_FAILED', providerSucceeded: true, reconciliationRequired: true })
    expect(sink).toHaveBeenCalled()
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
        return new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, output_image_count: 1, cost_cny: 0.001 }, data: [{ b64_json: VALID_PNG }] }), { status: 200 })
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
    expect(requestBody?.prompt).toEqual(expect.stringContaining('模型只负责生成商品、场景、光影和构图'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('画面不要素白'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('会员价 ¥99.00'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('同平台同类竞品研究'))
  })

  it('keeps a no-source create candidate unbranded and disables inferred marketing composition', async () => {
    let requestBody: Record<string, unknown> | undefined
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ id: 'concept-image', usage: { output_image_count: 1, cost_cny: 0.01 }, data: [{ b64_json: VALID_PNG }] }), { status: 200 })
      },
    })
    await generator.generate({
      productTitle: '有机燕麦奶 1L', category: '食品饮料', direction: '白底商品主图', count: 1,
      visualBrief: { platform: 'pinduoduo', placement: '商品主图', marketingLabels: ['有机燕麦奶 1L'], factLabels: ['净含量:1L'], marketingLayer: false },
    })
    const prompt = String(requestBody?.prompt)
    expect(prompt).toContain('无参考商品图')
    expect(prompt).toContain('无品牌、无文字、无标签')
    expect(prompt).toContain('只能作为概念候选')
    expect(prompt).toContain('已确认商品事实仅作为视觉约束')
    expect(prompt).not.toContain('已确认营销文案')
    expect(prompt).not.toContain('这是后置排版流程')
    expect(String(requestBody?.negative_prompt)).toContain('黑色竖栏')
  })

  it('does not deliver image artifacts when the usage receipt cannot be recorded', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      fetch: async () => new Response(JSON.stringify({ id: 'unsettled-image', usage: { output_image_count: 1 }, data: [{ b64_json: VALID_PNG }] }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 1, usageContext: { workspaceId: 'ws_image', actionId: 'image:unsettled' } })).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'sink' })
  })

  it('settles actual output units and rejects a conflicting provider image count', async () => {
    const sink = vi.fn<(record: RelayUsageRecord) => { recorded: true; costEvidence: true }>(() => ({ recorded: true, costEvidence: true }))
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: sink,
      fetch: async () => new Response(JSON.stringify({ id: 'image-count-mismatch', usage: { output_image_count: 2, cost_cny: 0.02 }, data: [{ b64_json: VALID_PNG }] }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 1 })).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', reconciliationRequired: true })
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ providerRequestId: 'image-count-mismatch', costCny: 0.02, metadata: expect.objectContaining({ billing_units: 2, observed_artifact_count: 1, artifact_count_mismatch: true }) }))
  })

  it('records the provider receipt but does not deliver a malformed image result body', async () => {
    const sink = vi.fn<(record: RelayUsageRecord) => { recorded: true; costEvidence: true }>(() => ({ recorded: true, costEvidence: true }))
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: sink,
      fetch: async () => new Response(JSON.stringify({ id: 'malformed-image-result', usage: { output_image_count: 1, cost_cny: 0.01 }, data: [{}] }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 1 })).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', reconciliationRequired: true })
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ providerRequestId: 'malformed-image-result', costCny: 0.01, metadata: expect.objectContaining({ billing_units: 1, billing_units_evidence: 'provider_usage' }) }))
    expect(sink.mock.calls[0]?.[0].metadata).not.toHaveProperty('observed_artifact_count')
  })

  it('leaves a malformed image response unsettled when provider units are absent', async () => {
    const sink = vi.fn(() => ({ recorded: true as const, costEvidence: true as const }))
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: sink,
      fetch: async () => new Response(JSON.stringify({ id: 'malformed-image-unmetered', cost_cny: 0.01, data: [{}] }), { status: 200 }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 1 })).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage' })
    expect(sink).not.toHaveBeenCalled()
  })

  it('blocks production dispatch before a missing usage sink can incur provider cost', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: VALID_PNG }] }), { status: 200 }))
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model',
      relaySecurity: { environment: 'production', allowedHosts: ['relay.example'] }, fetch,
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 1 })).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'sink' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('records actual provider units but blocks a malformed image edit artifact', async () => {
    const sink = vi.fn<(record: RelayUsageRecord) => { recorded: true; costEvidence: true }>(() => ({ recorded: true, costEvidence: true }))
    const generator = new OpenAICompatibleImageEditGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'edit-model', usageSink: sink,
      fetch: async () => new Response(JSON.stringify({ id: 'malformed-image-edit', usage: { output_image_count: 1, cost_cny: 0.01 }, data: [{}] }), { status: 200 }),
    })
    await expect(generator.generate({ prompt: '优化背景', sourceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }], region: { x: 0, y: 0, width: 1, height: 1 } })).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', reconciliationRequired: true })
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ providerRequestId: 'malformed-image-edit', costCny: 0.01, metadata: expect.objectContaining({ billing_units: 1, billing_units_evidence: 'provider_usage' }) }))
    expect(sink.mock.calls[0]?.[0].metadata).not.toHaveProperty('observed_artifact_count')
  })

  it('blocks an almost-empty white image edit artifact before candidate delivery', async () => {
    const generator = new OpenAICompatibleImageEditGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'edit-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ id: 'white-image-edit', usage: { output_image_count: 1, cost_cny: 0.01 }, data: [{ b64_json: solidWhitePng() }] }), { status: 200 }),
    })
    await expect(generator.generate({ prompt: '优化背景', sourceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }], region: { x: 0, y: 0, width: 1, height: 1 } })).rejects.toMatchObject({ code: 'IMAGE_ARTIFACT_QUALITY_FAILED', providerSucceeded: true, reconciliationRequired: true })
  })

  it('turns confirmed marketing inputs into a designed main-image layer', async () => {
    let requestBody: Record<string, unknown> | undefined
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ usage: { output_image_count: 1 }, data: [{ b64_json: VALID_PNG }] }), { status: 200 })
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
    expect(requestBody?.negative_prompt).toContain('中文文字')
    expect(requestBody?.negative_prompt).toContain('乱码')
  })

  it('turns a long-page request into an ordered conversion storyboard', async () => {
    let prompt = ''
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { prompt: string }
        prompt = body.prompt
        return new Response(JSON.stringify({ usage: { output_image_count: 1 }, data: [{ b64_json: VALID_PNG }] }), { status: 200 })
      },
    })
    await generator.generate({ productTitle: '外套', direction: '详情长图', count: 1, visualBrief: { size: '1024x4096', outputVariant: 'detail_long', detailSections: ['首屏价值主张：商品与核心收益', '参数规格：尺寸与适配'], marketingLabels: ['活动价 ¥99.00'] } })
    expect(prompt).toContain('长图必须按以下连续章节完成')
    expect(prompt).toContain('首屏价值主张：商品与核心收益 → 参数规格：尺寸与适配')
    expect(prompt).toContain('严禁把多个正方形卡片简单纵向拼接')
    expect(prompt).toContain('活动价 ¥99.00')
  })

  it('keeps a multi-image detail set visually consistent while varying chapter work', async () => {
    let prompt = ''
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => {
        prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt
        return new Response(JSON.stringify({ usage: { output_image_count: 4 }, data: Array.from({ length: 4 }, (_, index) => ({ url: `https://cdn.example/detail-${index + 1}.png` })) }), { status: 200 })
      },
    })
    await generator.generate({ productTitle: '外套', direction: '详情页套图', count: 4, visualBrief: { placement: 'detail_page', detailSections: ['首屏', '细节', '规格'], seriesConsistency: '统一网格、字体与色板' } })
    expect(prompt).toContain('同一商品的一组详情页套图（共 4 张）')
    expect(prompt).toContain('统一网格、字体与色板')
    expect(prompt).toContain('每张图承担不同章节任务')
  })

  it('uses a responsive conversion hierarchy for banners', async () => {
    let prompt = ''
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => {
        prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt
        return new Response(JSON.stringify({ usage: { output_image_count: 1 }, data: [{ b64_json: VALID_PNG }] }), { status: 200 })
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
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ usage: { output_image_count: 1 }, data: [{ b64_json: VALID_PNG }] }), { status: 200 })
      },
    })
    await generator.generate({ productTitle: '外套', direction: '白底主图', count: 1, sourceImages: ['data:image/png;base64,AQID'], visualBrief: { platform: 'taobao', placement: '商品主图' } })
    expect(requestBody?.prompt).toEqual(expect.stringContaining('不得原样回传参考图像素'))
    expect(requestBody?.prompt).toEqual(expect.stringContaining('平台模板执行：模板=搜索首屏商品 hero'))
  })

  it('honors an explicit scene redesign request for a Taobao main image', async () => {
    let requestBody: Record<string, unknown> | undefined
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ usage: { output_image_count: 1 }, data: [{ b64_json: VALID_PNG }] }), { status: 200 })
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
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => {
        prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt
        return new Response(JSON.stringify({ usage: { output_image_count: 1 }, data: [{ b64_json: VALID_PNG }] }), { status: 200 })
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

  it('rejects an image timeout that would abort the provider call instantly', () => {
    const relay = { MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'real-relay-key', IMAGE_MODEL: 'image-model' }
    expect(() => createImageGeneratorFromEnv({ ...relay, IMAGE_TIMEOUT_MS: '2m' })).toThrow('PROVIDER_TIMEOUT_INVALID')
    expect(() => createImageGeneratorFromEnv({ ...relay, IMAGE_TIMEOUT_MS: '0' })).toThrow('PROVIDER_TIMEOUT_INVALID')
    expect(createImageGeneratorFromEnv({ ...relay, IMAGE_TIMEOUT_MS: '120000' })).toBeDefined()
  })

  it('allows a provider-specific image path while rejecting absolute paths', async () => {
    let endpoint = ''
    const generator = new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }), path: '/v1/image/generate', fetch: async url => { endpoint = String(url); return new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, output_image_count: 1, cost_cny: 0.001 }, data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 }) } })
    await generator.generate({ productTitle: '外套', direction: '白底', count: 1 })
    expect(endpoint).toBe('https://relay.example/v1/image/generate')
    expect(() => new OpenAICompatibleImageGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'image-model', usageSink: () => ({ recorded: true, costEvidence: true }), path: 'https://evil.example/generate' })).toThrow('safe relative path')
  })

  it('sends approved source image bytes to the relay image-to-image endpoint', async () => {
    let body: Record<string, unknown> | undefined
    let endpoint = ''
    const generator = new OpenAICompatibleImageEditGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'edit-model', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async (url, init) => { endpoint = String(url); body = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, output_image_count: 1, cost_cny: 0.001 }, data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 }) } })
    await expect(generator.generate({ prompt: '优化背景', sourceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }], region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } })).resolves.toHaveLength(1)
    expect(endpoint).toBe('https://relay.example/images/generations')
    expect(body).toMatchObject({ image: ['data:image/png;base64,AQID'], image_mode: 'optimize', edit_region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, size: '1024x1024', response_format: 'url' })
  })

  it('maps the New API nested envelope for image edits', async () => {
    const generator = new OpenAICompatibleImageEditGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'edit-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ data: { request_id: 'nested-edit-request', data: [{ url: 'https://cdn.example/edited.png' }] }, usage: { output_image_count: 1, cost_cny: 0.01 } }), { status: 200 }),
    })
    await expect(generator.generate({ prompt: '优化背景', sourceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }], region: { x: 0, y: 0, width: 1, height: 1 } })).resolves.toEqual(['https://cdn.example/edited.png'])
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
        return new Response(JSON.stringify({ id: 'image-test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, output_image_count: 1, cost_cny: 0.001 }, data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
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
    return new Response(JSON.stringify({ id: 'long-page', usage: { total_tokens: 1, output_image_count: 1, cost_cny: 0.01 }, data: [{ url: 'https://cdn.example/long.png' }] }))
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
    return new Response(JSON.stringify({ id: 'native-long', usage: { output_image_count: 1, cost_cny: 0.01 }, data: [{ url: 'https://cdn.example/long.png' }] }))
  } })
  await generator.generate({ productTitle: '冲锋衣', direction: '六章节详情页', count: 1, mode: 'optimize', sourceImages: [source], visualBrief: { size: '1024x4096' } })
})
