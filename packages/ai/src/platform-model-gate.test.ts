import { describe, expect, it } from 'vitest'
import { evaluatePlatformModelBudgetEstimate, evaluatePlatformModelCostGate, evaluatePlatformModelGate, evaluatePlatformModelRelayGate, evaluatePlatformModelRequestCost, evaluatePlatformModelTaskCostLimit, evaluatePlatformModelTaskRequestCost } from './platform-model-gate.js'

describe('platform-owned model gate', () => {
  it('requires an explicit versioned conservative estimate for every modality', () => {
    expect(evaluatePlatformModelBudgetEstimate({}, 'text')).toMatchObject({ ready: false, reasons: ['request_estimate_missing_or_invalid', 'estimate_version_missing'] })
    const source = { MODEL_COST_ESTIMATE_VERSION: 'pricing-2026-08-29', MODEL_TEXT_MAX_REQUEST_CNY: '0.25', MODEL_IMAGE_MAX_REQUEST_CNY: '1.50', MODEL_IMAGE_EDIT_MAX_REQUEST_CNY: '1.75', MODEL_OCR_MAX_REQUEST_CNY: '0.40', MODEL_VIDEO_MAX_REQUEST_CNY: '600' }
    expect((['text', 'image', 'image_edit', 'ocr', 'video'] as const).map(kind => evaluatePlatformModelBudgetEstimate(source, kind))).toEqual([
      expect.objectContaining({ ready: true, amountCny: 0.25, version: 'pricing-2026-08-29' }),
      expect.objectContaining({ ready: true, amountCny: 1.5 }), expect.objectContaining({ ready: true, amountCny: 1.75 }), expect.objectContaining({ ready: true, amountCny: 0.4 }), expect.objectContaining({ ready: true, amountCny: 600 }),
    ])
  })

  it('keeps the per-task cap distinct from the workspace daily budget', () => {
    const source = { MODEL_MAX_TASK_COST_CNY: '0.50', MODEL_DAILY_CNY_LIMIT: '100' }
    expect(evaluatePlatformModelTaskCostLimit(source)).toMatchObject({ ready: true, limitCny: 0.5 })
    expect(evaluatePlatformModelTaskRequestCost(0.5, source)).toMatchObject({ ready: true })
    expect(evaluatePlatformModelTaskRequestCost(0.500001, source)).toMatchObject({ ready: false, reasons: ['request_cost_exceeds_task_limit'] })
    expect(evaluatePlatformModelTaskCostLimit({ MODEL_MAX_TASK_COST_CNY: '101', MODEL_DAILY_CNY_LIMIT: '100' })).toMatchObject({ ready: false, reasons: ['task_cny_limit_exceeds_daily_limit'] })
  })
  it('requires HTTPS, platform credential and pinned model', () => {
    expect(evaluatePlatformModelGate({ AI_BASE_URL: 'https://model.example', AI_API_KEY: 'platform-secret', AI_MODEL: 'text-v1' }, 'text')).toMatchObject({ ready: false, reasons: ['endpoint_missing', 'api_key_missing'] })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'http://relay.example', MODEL_RELAY_API_KEY: 'platform-secret', AI_MODEL: 'text-v1' }, 'text')).toMatchObject({ ready: false, reasons: ['endpoint_must_use_https'] })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'platform-secret', AI_MODEL: 'text-v1' }, 'text')).toMatchObject({ ready: true, endpointHost: 'relay.example' })
  })

  it('requires all platform cost controls before allowing model traffic', () => {
    expect(evaluatePlatformModelCostGate({ MODEL_RPM_LIMIT: '100', MODEL_TPM_LIMIT: '10000' })).toMatchObject({ ready: false, reasons: ['daily_cny_limit_missing_or_invalid'] })
    expect(evaluatePlatformModelCostGate({ MODEL_RPM_LIMIT: '100', MODEL_TPM_LIMIT: '10000', MODEL_DAILY_CNY_LIMIT: '50.00' })).toMatchObject({ ready: true, dailyCnyLimit: 50 })
  })

  it('blocks a single provider request that already exceeds the daily CNY ceiling', () => {
    expect(evaluatePlatformModelRequestCost(5, 10)).toMatchObject({ ready: true, reasons: [] })
    expect(evaluatePlatformModelRequestCost(544.265625, 10)).toMatchObject({ ready: false, reasons: ['request_cost_exceeds_daily_limit'] })
    expect(evaluatePlatformModelRequestCost(Number.NaN, 10)).toMatchObject({ ready: false, reasons: ['request_cost_missing_or_invalid'] })
  })

  it('requires a platform-owned HTTPS relay endpoint', () => {
    expect(evaluatePlatformModelRelayGate({})).toMatchObject({ ready: false, reasons: ['model_relay_endpoint_missing'] })
    expect(evaluatePlatformModelRelayGate({ MODEL_RELAY_BASE_URL: 'http://relay.example' })).toMatchObject({ ready: false, reasons: ['model_relay_endpoint_must_use_https'] })
    expect(evaluatePlatformModelRelayGate({ MODEL_RELAY_BASE_URL: 'https://relay.example' })).toMatchObject({ ready: true, endpointHost: 'relay.example' })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', AI_API_KEY: 'direct-key', AI_MODEL: 'text-v1' }, 'text')).toMatchObject({ ready: false, reasons: ['api_key_missing'] })
  })

  it('reports OCR and video model readiness through the same relay gate', () => {
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay-key', OCR_MODEL: 'vision-v1' }, 'ocr')).toMatchObject({ ready: true, endpointHost: 'relay.example' })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay-key' }, 'video')).toMatchObject({ ready: false, reasons: ['model_missing'] })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', VIDEO_MODEL_RELAY_API_KEY: 'video-key', VIDEO_MODEL: 'video-v1' }, 'video')).toMatchObject({ ready: true, endpointHost: 'relay.example' })
    expect(evaluatePlatformModelGate({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay-key', IMAGE_MODEL: 'image-v1' }, 'image_edit')).toMatchObject({ ready: true, endpointHost: 'relay.example' })
  })

  it('treats whitespace-only primary model variables as missing for every modality', () => {
    const relay = { MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay-key' }
    expect(evaluatePlatformModelGate({ ...relay, AI_MODEL: '  ', MODEL_ID: 'text-v1' }, 'text')).toMatchObject({ ready: true })
    expect(evaluatePlatformModelGate({ ...relay, IMAGE_MODEL: '  ', AI_IMAGE_MODEL: 'image-v1' }, 'image')).toMatchObject({ ready: true })
    expect(evaluatePlatformModelGate({ ...relay, IMAGE_EDIT_MODEL: '  ', IMAGE_MODEL: '  ', AI_IMAGE_MODEL: 'image-v1' }, 'image_edit')).toMatchObject({ ready: true })
    expect(evaluatePlatformModelGate({ ...relay, OCR_MODEL: '  ', AI_VISION_MODEL: 'ocr-v1' }, 'ocr')).toMatchObject({ ready: true })
    expect(evaluatePlatformModelGate({ ...relay, VIDEO_MODEL: '  ', AI_VIDEO_MODEL: 'video-v1' }, 'video')).toMatchObject({ ready: true })
  })

  it('fails closed when image relay credentials or model ids are placeholders', () => {
    const result = evaluatePlatformModelGate({
      MODEL_RELAY_BASE_URL: 'https://relay.example',
      MODEL_RELAY_API_KEY: '${MODEL_RELAY_API_KEY}',
      IMAGE_MODEL: 'REPLACE_WITH_IMAGE_MODEL',
    }, 'image')
    expect(result).toMatchObject({ ready: false, reasons: expect.arrayContaining(['api_key_placeholder', 'model_placeholder']) })
  })
})
