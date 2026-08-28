import { describe, expect, it } from 'vitest'
import { OpenAICompatibleImageFactsExtractor, createImageFactsExtractorFromEnv } from './image-facts.js'

describe('platform-relay image facts extraction', () => {
  it('sends image facts extraction only to the configured relay and normalizes candidates', async () => {
    let requestedUrl = ''
    const extractor = new OpenAICompatibleImageFactsExtractor({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'vision-v1',
      fetch: async (url, init) => { requestedUrl = String(url); expect(init?.body).toContain('data:image/png;base64'); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts: { product_name: '春季外套', stock: 8 }, ocr_text: '春季外套' }) } }] }), { status: 200 }) },
    })
    await expect(extractor.extract({ name: 'label.png', mimeType: 'image/png', body: Buffer.from('png') })).resolves.toMatchObject({ format: 'image_ocr', product_name: '春季外套', stock: 8, ocr_text: '春季外套' })
    expect(requestedUrl).toBe('https://relay.example/chat/completions')
  })

  it('does not create an OCR provider without the platform relay and relay key', () => {
    expect(createImageFactsExtractorFromEnv({ OCR_MODEL: 'vision-v1', AI_BASE_URL: 'https://direct.example', AI_API_KEY: 'direct-key' })).toBeUndefined()
    expect(createImageFactsExtractorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', OCR_MODEL: 'vision-v1' })).toBeUndefined()
    expect(createImageFactsExtractorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay-key', OCR_MODEL: 'vision-v1' })).toBeDefined()
  })
})
