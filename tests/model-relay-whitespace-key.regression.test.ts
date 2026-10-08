import { describe, expect, it } from 'vitest'
import { evaluatePlatformModelGate } from '../packages/ai/src/platform-model-gate.js'

const modalities = ['text', 'image', 'image_edit', 'ocr', 'video', 'embedding'] as const

describe('model relay credential whitespace boundary', () => {
  it.each(modalities)('fails %s closed when configured relay credentials contain only whitespace', modality => {
    const source = {
      NODE_ENV: 'test',
      MODEL_RELAY_BASE_URL: 'https://relay.test.invalid/v1',
      MODEL_RELAY_API_KEY: ' \t ',
      VIDEO_MODEL_RELAY_API_KEY: ' \t ',
      AI_MODEL: 'text-v1',
      IMAGE_MODEL: 'image-v1',
      IMAGE_EDIT_MODEL: 'image-edit-v1',
      OCR_MODEL: 'ocr-v1',
      VIDEO_MODEL: 'video-v1',
      EMBEDDING_MODEL: 'embedding-v1',
    }

    const result = evaluatePlatformModelGate(source, modality)
    expect(result).toMatchObject({
      ready: false,
      reasons: expect.arrayContaining(['api_key_missing']),
    })
    // Prove the credential path is the blocker for every modality, including
    // embedding, rather than an unrelated missing model configuration.
    expect(result.reasons).not.toContain('model_missing')
  })
})
