import { describe, expect, it } from 'vitest'
import { OpenAICompatibleImageFactsExtractor, createImageFactsExtractorFromEnv } from './image-facts.js'

describe('platform-relay image facts extraction', () => {
  it('sends image facts extraction only to the configured relay and normalizes candidates', async () => {
    let requestedUrl = ''
    const extractor = new OpenAICompatibleImageFactsExtractor({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'vision-v1',
      usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (url, init) => { requestedUrl = String(url); expect(init?.body).toContain('data:image/png;base64'); expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 512 }); return new Response(JSON.stringify({ id: 'ocr-request-1', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost_cny: 0.01 }, choices: [{ message: { content: JSON.stringify({ facts: { product_name: '春季外套', stock: 8 }, ocr_text: '春季外套' }) } }] }), { status: 200 }) },
    })
    await expect(extractor.extract({ name: 'label.png', mimeType: 'image/png', body: Buffer.from('png') })).resolves.toMatchObject({ format: 'image_ocr', product_name: '春季外套', stock: 8, ocr_text: '春季外套' })
    expect(requestedUrl).toBe('https://relay.example/chat/completions')
  })

  it('does not create an OCR provider without the platform relay and relay key', () => {
    expect(createImageFactsExtractorFromEnv({ OCR_MODEL: 'vision-v1', AI_BASE_URL: 'https://direct.example', AI_API_KEY: 'direct-key' })).toBeUndefined()
    expect(createImageFactsExtractorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', OCR_MODEL: 'vision-v1' })).toBeUndefined()
    expect(createImageFactsExtractorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay-key', OCR_MODEL: 'vision-v1' })).toBeDefined()
    expect(() => createImageFactsExtractorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay-key', OCR_MODEL: 'vision-v1', OCR_TIMEOUT_MS: '90s' })).toThrow('PROVIDER_TIMEOUT_INVALID')
  })

  it('does not assemble an OCR provider from placeholder relay configuration', () => {
    expect(createImageFactsExtractorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: '${MODEL_RELAY_API_KEY}', OCR_MODEL: 'REPLACE_WITH_OCR_MODEL' })).toBeUndefined()
    expect(createImageFactsExtractorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'real-relay-key', OCR_MODEL: 'your-vision-model' })).toBeUndefined()
  })

  it('requires an explicit bounded output limit in production', () => {
    const relay = { NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_ALLOWED_HOSTS: 'relay.example', MODEL_RELAY_API_KEY: 'relay-key', OCR_MODEL: 'vision-v1' }
    expect(() => createImageFactsExtractorFromEnv(relay)).toThrow('OCR_MAX_OUTPUT_TOKENS_REQUIRED')
    expect(() => createImageFactsExtractorFromEnv({ ...relay, OCR_MAX_OUTPUT_TOKENS: '0' })).toThrow('OCR_MAX_OUTPUT_TOKENS_INVALID')
    expect(() => createImageFactsExtractorFromEnv({ ...relay, OCR_MAX_OUTPUT_TOKENS: '4097' })).toThrow('OCR_MAX_OUTPUT_TOKENS_INVALID')
    expect(() => createImageFactsExtractorFromEnv({ ...relay, OCR_MAX_OUTPUT_TOKENS: '1.5' })).toThrow('OCR_MAX_OUTPUT_TOKENS_INVALID')
    expect(createImageFactsExtractorFromEnv({ ...relay, OCR_MAX_OUTPUT_TOKENS: '256' })).toBeDefined()
  })

  it('sends the configured output limit to the OCR relay', async () => {
    const extractor = new OpenAICompatibleImageFactsExtractor({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'vision-v1', maxOutputTokens: 256,
      usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'vision-v1', max_tokens: 256 })
        return new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost_cny: 0.01 }, choices: [{ message: { content: '{"facts":{"label":"test"}}' } }] }), { status: 200 })
      },
    })
    await expect(extractor.extract({ name: 'test.png', mimeType: 'image/png', body: Buffer.from('png') })).resolves.toMatchObject({ label: 'test' })
  })
})
