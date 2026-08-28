import { describe, expect, it } from 'vitest'
import {
  ONE_SENTENCE_CAPABILITIES,
  createImageEditCandidate,
  createImageGenerationRequest,
  createImageLocalEditRequest,
  createImageRegion,
  createOneSentenceGenerationRequest,
  createTextGenerationRequest,
  createVideoGenerationRequest,
  createVideoRenderingRequest,
  parseGenerationContext,
  serializeImageEditCandidate,
  serializeGenerationContext,
  validateImageEditRequest,
  type GenerationContext,
  type ImageLocalEditRequest,
} from './multimodal.js'

const context: GenerationContext = {
  brand: { id: 'brand-snapshot-1', version: 'v3', hash: 'sha256:brand' },
  product: { id: 'product-snapshot-9', version: 'v2', hash: 'sha256:product' },
  rules: [{ id: 'rule-platform-1', version: '2026.08', hash: 'sha256:rules' }],
}

const editRequest = (overrides: Partial<ImageLocalEditRequest> = {}): ImageLocalEditRequest => ({
  kind: 'image_local_edit',
  id: 'edit-1',
  sourceImage: { id: 'image-original-1', uri: 'https://example.test/original.png', width: 1200, height: 1200 },
  prompt: '把杯身上的文案改成春日限定，但保留 Logo。',
  region: { id: 'target-copy', rect: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 } },
  constraints: {
    editableRegions: [{ id: 'copy-area', rect: { x: 0.1, y: 0.2, width: 0.7, height: 0.5 } }],
    nonModifiableRegions: [{ id: 'logo', rect: { x: 0.7, y: 0.05, width: 0.2, height: 0.15 } }],
  },
  context,
  ...overrides,
})

describe('multimodal capability declarations', () => {
  it('declares one-sentence text/image and staged video capabilities', () => {
    expect(ONE_SENTENCE_CAPABILITIES).toEqual(expect.arrayContaining([
      expect.objectContaining({ modality: 'text', output: 'text', stage: 'available' }),
      expect.objectContaining({ modality: 'image', output: 'image', stage: 'available' }),
      expect.objectContaining({ modality: 'video', output: 'script', stage: 'available' }),
      expect.objectContaining({ modality: 'video', output: 'storyboard', stage: 'available' }),
      expect.objectContaining({ modality: 'video', output: 'rendering', stage: 'planned' }),
    ]))
  })

  it('accepts scripts/storyboards and validates rendered-video requests separately', () => {
    expect(createVideoGenerationRequest({ prompt: '做一个春季上新短视频', output: 'script', context }).ok).toBe(true)
    const rendering = createVideoGenerationRequest({ prompt: '直接渲染成片', output: 'rendering', context })
    expect(rendering).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'VIDEO_RENDERING_NOT_AVAILABLE' })] })
    expect(createVideoRenderingRequest({ prompt: '直接渲染成片', context })).toMatchObject({ ok: true, value: { output: 'rendering', rendering: 'requested' } })
  })

  it('rejects an invalid video output at the runtime boundary', () => {
    const result = createVideoGenerationRequest({ prompt: '不应执行', output: 'mp4' as never, context })
    expect(result).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'INVALID_VIDEO_OUTPUT', path: 'output' })] })
  })
})

describe('generation context and request contracts', () => {
  it('requires brand, product and at least one rules snapshot', () => {
    expect(createTextGenerationRequest({ prompt: '写一段通勤保温杯卖点', context }).ok).toBe(true)
    expect(createImageGenerationRequest({ prompt: '生成春日通勤场景图', context }).ok).toBe(true)
    const missingRules = createOneSentenceGenerationRequest({
      modality: 'text',
      prompt: '写文案',
      context: { ...context, rules: [] },
    })
    expect(missingRules).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: 'rules' })] })
  })

  it('round-trips context as plain JSON', () => {
    const restored = parseGenerationContext(serializeGenerationContext(context))
    expect(restored).toEqual({ ok: true, value: context })
  })
})

describe('image local edit invariants', () => {
  it('validates a target region and creates a separate candidate', () => {
    const request = editRequest()
    expect(createImageRegion(request.region)).toEqual({ ok: true, value: request.region })
    expect(createImageLocalEditRequest({
      id: request.id,
      sourceImage: request.sourceImage,
      prompt: request.prompt,
      region: request.region,
      constraints: request.constraints,
      context: request.context,
    })).toEqual({ ok: true, value: request })
    expect(validateImageEditRequest(request)).toEqual({ ok: true, value: request })

    const candidate = createImageEditCandidate(request, 'candidate-1')
    expect(candidate).toMatchObject({ ok: true, value: {
      id: 'candidate-1',
      sourceImageId: 'image-original-1',
      originalPreserved: true,
      status: 'candidate',
    } })
    expect(candidate.ok && JSON.parse(serializeImageEditCandidate(candidate.value))).toMatchObject({
      sourceImageId: 'image-original-1',
      originalPreserved: true,
    })
    expect(request.sourceImage.id).toBe('image-original-1')
  })

  it('rejects out-of-bounds regions and regions overlapping protected areas', () => {
    const outOfBounds = validateImageEditRequest(editRequest({
      region: { id: 'bad', rect: { x: 0.8, y: 0.8, width: 0.3, height: 0.1 } },
    }))
    expect(outOfBounds).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'INVALID_REGION' })] })

    const protectedOverlap = validateImageEditRequest(editRequest({
      region: { id: 'logo', rect: { x: 0.72, y: 0.08, width: 0.1, height: 0.1 } },
      constraints: { nonModifiableRegions: [{ id: 'logo', rect: { x: 0.7, y: 0.05, width: 0.2, height: 0.15 } }] },
    }))
    expect(protectedOverlap).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'REGION_OVERLAPS_NON_MODIFIABLE_AREA' })] })
  })

  it('rejects a region outside the declared editable area', () => {
    const result = validateImageEditRequest(editRequest({
      region: { id: 'outside', rect: { x: 0.85, y: 0.8, width: 0.1, height: 0.1 } },
      constraints: { editableRegions: [{ id: 'copy', rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 } }] },
    }))
    expect(result).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'REGION_OUTSIDE_EDITABLE_AREA' })] })
  })
})
