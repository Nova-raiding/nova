import { describe, expect, it } from 'vitest'
import { createContentGeneratorFromEnv } from './generator.js'
import { createImageGeneratorFromEnv } from './image-generator.js'
import { createImageEditGeneratorFromEnv } from './image-editor.js'
import { createImageFactsExtractorFromEnv } from './image-facts.js'
import { createVideoGeneratorFromEnv } from './video-generator.js'
import { createEmbeddingClientFromEnv } from './embedding.js'
import { evaluatePlatformModelGate } from './platform-model-gate.js'

const relayConfiguration = {
  NODE_ENV: 'test',
  MODEL_RELAY_BASE_URL: 'https://relay.test.invalid/v1',
  MODEL_RELAY_API_KEY: '',
  VIDEO_MODEL_RELAY_API_KEY: '',
  AI_MODEL: 'text-v1',
  IMAGE_MODEL: 'image-v1',
  IMAGE_EDIT_MODEL: 'image-edit-v1',
  OCR_MODEL: 'ocr-v1',
  VIDEO_MODEL: 'video-v1',
  EMBEDDING_MODEL: 'embedding-v1',
}

const factories = [
  ['text', () => createContentGeneratorFromEnv(relayConfiguration)],
  ['image', () => createImageGeneratorFromEnv(relayConfiguration)],
  ['image_edit', () => createImageEditGeneratorFromEnv(relayConfiguration)],
  ['ocr', () => createImageFactsExtractorFromEnv(relayConfiguration)],
  ['video', () => createVideoGeneratorFromEnv(relayConfiguration)],
  ['embedding', () => createEmbeddingClientFromEnv(relayConfiguration)],
] as const

describe('model relay empty-key fail-closed regression', () => {
  it.each(factories)('%s reports the missing credential and does not assemble a provider', (modality, create) => {
    expect(evaluatePlatformModelGate(relayConfiguration, modality)).toMatchObject({
      ready: false,
      reasons: expect.arrayContaining(['api_key_missing']),
    })
    expect(create()).toBeUndefined()
  })

  it('does not treat an empty video-specific key as an authenticated fallback', () => {
    const modelKeyMissing = {
      ...relayConfiguration,
      MODEL_RELAY_API_KEY: undefined,
      VIDEO_MODEL_RELAY_API_KEY: '',
    }

    expect(evaluatePlatformModelGate(modelKeyMissing, 'video')).toMatchObject({
      ready: false,
      reasons: expect.arrayContaining(['api_key_missing']),
    })
    expect(createVideoGeneratorFromEnv(modelKeyMissing)).toBeUndefined()
  })
})
