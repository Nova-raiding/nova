import { describe, expect, it } from 'vitest'
import { OpenAICompatibleContentGenerator } from './generator.js'
import { OpenAICompatibleImageGenerator } from './image-generator.js'
import { OpenAICompatibleImageEditGenerator } from './image-editor.js'
import { OpenAICompatibleImageFactsExtractor } from './image-facts.js'
import { OpenAICompatibleVideoGenerator } from './video-generator.js'

const common = { apiKey: 'local-test-key', model: 'local-test-model' }

describe('direct model adapters keep the relay boundary fail-closed', () => {
  it.each([
    ['content', (baseUrl: string) => new OpenAICompatibleContentGenerator({ ...common, baseUrl })],
    ['image', (baseUrl: string) => new OpenAICompatibleImageGenerator({ ...common, baseUrl })],
    ['image edit', (baseUrl: string) => new OpenAICompatibleImageEditGenerator({ ...common, baseUrl })],
    ['OCR', (baseUrl: string) => new OpenAICompatibleImageFactsExtractor({ ...common, baseUrl })],
    ['video', (baseUrl: string) => new OpenAICompatibleVideoGenerator({ ...common, baseUrl })],
  ])('%s rejects HTTP relay URLs before any request can be made', (_name, create) => {
    expect(() => create('http://relay.example.test')).toThrow('must use HTTPS')
  })

  it('rejects relay credentials and query strings before request construction', () => {
    expect(() => new OpenAICompatibleContentGenerator({ ...common, baseUrl: 'https://user:secret@relay.example.test/v1' })).toThrow('must not contain credentials')
    expect(() => new OpenAICompatibleImageGenerator({ ...common, baseUrl: 'https://relay.example.test/v1?token=secret' })).toThrow('must not contain credentials')
  })
})
