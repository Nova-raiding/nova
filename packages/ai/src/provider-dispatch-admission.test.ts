import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContentGeneratorFromEnv, OpenAICompatibleContentGenerator } from './generator.js'
import { createImageGeneratorFromEnv, OpenAICompatibleImageGenerator } from './image-generator.js'
import { createImageEditGeneratorFromEnv, OpenAICompatibleImageEditGenerator } from './image-editor.js'
import { createImageFactsExtractorFromEnv, OpenAICompatibleImageFactsExtractor } from './image-facts.js'
import { createVideoGeneratorFromEnv, OpenAICompatibleVideoGenerator } from './video-generator.js'
import { ProviderOutcomeUnknownError, type ProviderBeforeRequest } from './provider-request.js'
import type { RelayUsageSink } from './relay-usage.js'
import * as relaySecurity from './relay-security.js'

const usageContext = { workspaceId: 'workspace-a', actionId: 'action-a' }
const contentInput = { platform: 'jd', product: { title: '商品', stock: 1, skuCount: 1 }, directionId: 'direction-a', usageContext }
const imageInput = { productTitle: '商品', direction: '正面', count: 1, usageContext }
const editInput = { prompt: '调整背景', sourceImages: [{ bytes: new Uint8Array([1]), mimeType: 'image/png' }], region: { x: 0, y: 0, width: 1, height: 1 }, usageContext }
const ocrInput = { name: 'label.png', mimeType: 'image/png', body: new Uint8Array([1]), usageContext }
const videoInput = { prompt: '展示商品', output: 'rendering' as const, context: {}, usageContext }
const common = { baseUrl: 'https://relay.test/v1', apiKey: 'configured-key', model: 'configured-model', relaySecurity: { environment: 'test' } }
const env = { NODE_ENV: 'test', MODEL_RELAY_BASE_URL: common.baseUrl, MODEL_RELAY_API_KEY: common.apiKey, AI_MODEL: 'gpt-4.1', IMAGE_MODEL: 'gpt-image-1', IMAGE_EDIT_MODEL: 'gpt-image-1', OCR_MODEL: 'qwen-vl-plus', VIDEO_MODEL: 'veo-3' }
type Options = typeof common & { fetch?: typeof fetch; beforeRequest?: ProviderBeforeRequest; usageSink?: RelayUsageSink }
const adapters = [
  { operation: 'text_generate', call: (options: Options) => new OpenAICompatibleContentGenerator(options).generate(contentInput), fromEnv: (hook: ProviderBeforeRequest) => createContentGeneratorFromEnv(env, undefined, hook)!.generate(contentInput) },
  { operation: 'image_generate', call: (options: Options) => new OpenAICompatibleImageGenerator(options).generate(imageInput), fromEnv: (hook: ProviderBeforeRequest) => createImageGeneratorFromEnv(env, undefined, hook)!.generate(imageInput) },
  { operation: 'image_edit', call: (options: Options) => new OpenAICompatibleImageEditGenerator(options).generate(editInput), fromEnv: (hook: ProviderBeforeRequest) => createImageEditGeneratorFromEnv(env, undefined, hook)!.generate(editInput) },
  { operation: 'ocr', call: (options: Options) => new OpenAICompatibleImageFactsExtractor(options).extract(ocrInput), fromEnv: (hook: ProviderBeforeRequest) => createImageFactsExtractorFromEnv(env, undefined, hook)!.extract(ocrInput) },
  { operation: 'video_generate', call: (options: Options) => new OpenAICompatibleVideoGenerator(options).generate(videoInput), fromEnv: (hook: ProviderBeforeRequest) => createVideoGeneratorFromEnv(env, undefined, hook)!.generate(videoInput) },
]

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('trusted provider dispatch admission', () => {
  it.each(adapters)('$operation preserves a local TypeError denial without dispatch or provider usage', async adapter => {
    const denial = Object.assign(new TypeError('access revoked'), { code: 'CUSTOMER_DELIVERY_REQUIRED', retryable: false })
    const fetchMock = vi.fn<typeof fetch>()
    const usageSink = vi.fn<RelayUsageSink>()
    const beforeRequest = vi.fn<ProviderBeforeRequest>(() => { throw denial })
    await expect(adapter.call({ ...common, fetch: fetchMock, beforeRequest, usageSink })).rejects.toBe(denial)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(usageSink).not.toHaveBeenCalled()
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith({ operation: adapter.operation, ...usageContext, signal: expect.any(AbortSignal) })
    expect(denial).not.toBeInstanceOf(ProviderOutcomeUnknownError)
  })

  it.each(adapters)('$operation checks after delayed relay preflight and observes revocation', async adapter => {
    let release!: () => void
    const preflight = new Promise<void>(resolve => { release = resolve })
    const inspected = vi.spyOn(relaySecurity, 'assertRelayUrl').mockImplementation(() => preflight)
    let allowed = true
    const denial = new Error('revoked while preflight was pending')
    const beforeRequest = vi.fn<ProviderBeforeRequest>(() => { if (!allowed) throw denial })
    const fetchMock = vi.fn<typeof fetch>()
    const pending = adapter.call({ ...common, fetch: fetchMock, beforeRequest })
    const result = expect(pending).rejects.toBe(denial)
    expect(inspected).toHaveBeenCalledOnce()
    expect(beforeRequest).not.toHaveBeenCalled()
    allowed = false
    release()
    await result
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(adapters)('$operation rechecks after a known failed 429 before any retry fetch', async adapter => {
    let allowed = true
    const denial = Object.assign(new Error('revoked during retry wait'), { code: 'CUSTOMER_DELIVERY_REQUIRED', retryable: false })
    const beforeRequest = vi.fn<ProviderBeforeRequest>(() => { if (!allowed) throw denial })
    const fetchMock = vi.fn<typeof fetch>(async () => {
      allowed = false
      return new Response('{}', { status: 429, headers: { 'retry-after': '0' } })
    })
    await expect(adapter.call({ ...common, fetch: fetchMock, beforeRequest })).rejects.toBe(denial)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(beforeRequest).toHaveBeenCalledTimes(2)
  })

  it.each(adapters)('$operation environment factory forwards the trusted hook', async adapter => {
    const denial = new Error('factory dispatch rejected')
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const hook = vi.fn<ProviderBeforeRequest>(() => { throw denial })
    await expect(adapter.fromEnv(hook)).rejects.toBe(denial)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(hook).toHaveBeenCalledOnce()
  })

  it('keeps receipt queries separately classifiable without generation admission', async () => {
    const beforeRequest = vi.fn<ProviderBeforeRequest>(context => {
      if (!['image_query', 'video_query'].includes(context.operation)) throw new Error('generation denied')
    })
    const imageFetch = vi.fn<typeof fetch>(async () => Response.json({ id: 'image-job', status: 'processing' }))
    const videoFetch = vi.fn<typeof fetch>(async () => Response.json({ id: 'video-job', status: 'queued' }))
    await expect(new OpenAICompatibleImageGenerator({ ...common, fetch: imageFetch, beforeRequest }).queryStatus('image-job')).resolves.toMatchObject({ state: 'processing' })
    await expect(new OpenAICompatibleVideoGenerator({ ...common, fetch: videoFetch, beforeRequest }).getStatus('video-job')).resolves.toMatchObject({ status: 'queued' })
    expect(beforeRequest.mock.calls.map(([context]) => context.operation)).toEqual(['image_query', 'video_query'])
    expect(imageFetch).toHaveBeenCalledOnce()
    expect(videoFetch).toHaveBeenCalledOnce()
  })

  it('does not classify a local status-query TypeError as an ambiguous provider request', async () => {
    const denial = new TypeError('local query denied')
    const fetchMock = vi.fn<typeof fetch>()
    const beforeRequest: ProviderBeforeRequest = () => { throw denial }
    await expect(new OpenAICompatibleImageGenerator({ ...common, fetch: fetchMock, beforeRequest }).queryStatus('image-job')).rejects.toBe(denial)
    await expect(new OpenAICompatibleVideoGenerator({ ...common, fetch: fetchMock, beforeRequest }).getStatus('video-job')).rejects.toBe(denial)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
