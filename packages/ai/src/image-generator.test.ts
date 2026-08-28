import { describe, expect, it } from 'vitest'
import { OpenAICompatibleImageGenerator, createImageGeneratorFromEnv } from './image-generator.js'
import { OpenAICompatibleImageEditGenerator } from './image-editor.js'

describe('image generator', () => {
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

  it('only enables image generation through the HTTPS platform relay', () => {
    expect(createImageGeneratorFromEnv({ IMAGE_BASE_URL: 'https://image.example', IMAGE_MODEL: 'model' })).toBeUndefined()
    expect(createImageGeneratorFromEnv({ IMAGE_BASE_URL: 'https://image.example', IMAGE_API_KEY: 'key', IMAGE_MODEL: 'model' })).toBeUndefined()
    expect(createImageGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'http://relay.example', MODEL_RELAY_API_KEY: 'key', IMAGE_MODEL: 'model' })).toBeUndefined()
    expect(createImageGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'key', IMAGE_MODEL: 'model' })).toBeDefined()
  })

  it('sends approved source image bytes to the relay image-to-image endpoint', async () => {
    let body: Record<string, unknown> | undefined
    const generator = new OpenAICompatibleImageEditGenerator({ baseUrl: 'https://relay.example', apiKey: 'secret', model: 'edit-model', fetch: async (_url, init) => { body = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 }) } })
    await expect(generator.generate({ prompt: '优化背景', sourceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }], region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } })).resolves.toHaveLength(1)
    expect(body).toMatchObject({ image: ['data:image/png;base64,AQID'], image_mode: 'optimize', edit_region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } })
  })

  it('rejects an oversized model relay response before parsing it', async () => {
    const generator = new OpenAICompatibleImageGenerator({
      baseUrl: 'https://image.example', apiKey: 'secret', model: 'image-model',
      fetch: async () => new Response('{"data":[]}', { headers: { 'content-length': String(33 * 1024 * 1024) } }),
    })
    await expect(generator.generate({ productTitle: '外套', direction: '白底', count: 1 })).rejects.toThrow('safety limit')
  })
})
