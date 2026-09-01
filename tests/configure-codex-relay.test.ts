import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderCodexRelayConfig } from '../scripts/configure-codex-relay.js'
import { probeCodexRelayCatalog, validateCodexRelay } from '../scripts/validate-codex-relay.js'

describe('Codex relay configuration renderer', () => {
  it('uses an OCR canary image large enough for production vision model constraints', () => {
    const source = readFileSync('scripts/model-relay-canary.ts', 'utf8')
    const encoded = source.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/u)?.[1]
    expect(encoded).toBeTruthy()
    const png = Buffer.from(encoded!, 'base64')
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(16)
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(16)
  })

  it('includes the per-duration billing field in the real video relay canary', () => {
    const source = readFileSync('scripts/model-relay-canary.ts', 'utf8')
    expect(source).toContain("duration: videoDurationSeconds")
    expect(source).not.toContain("output: 'rendering', context: { canary: true }")
  })

  it('records auditable pricing fields and can reuse a paid video task for status evidence', () => {
    const source = readFileSync('scripts/model-relay-canary.ts', 'utf8')
    expect(source).toContain('MODEL_RELAY_CANARY_VIDEO_TASK_ID')
    expect(source).toContain('pricingVersion: quote.metadata.pricing_version')
    expect(source).toContain('pricingGroup: quote.metadata.pricing_group')
    expect(source).toContain('costCny: quote.costCny')
  })

  it('preserves unrelated settings and replaces the selected provider section', () => {
    const rendered = renderCodexRelayConfig({
      existing: 'approval_policy = "on-request"\nmodel = "old"\nmodel_provider = "old_provider"\n\n[model_providers.damai_relay]\nbase_url = "https://old.example/v1"\n\n[other]\nvalue = true\n',
      provider: 'damai_relay', model: 'responses-model', baseUrl: 'https://relay.example/v1', apiKeyEnv: 'DAMAI_CODEX_RELAY_API_KEY',
    })
    expect(rendered).toContain('approval_policy = "on-request"')
    expect(rendered).toContain('model = "responses-model"')
    expect(rendered).toContain('model_provider = "damai_relay"')
    expect(rendered).toContain('wire_api = "responses"')
    expect(rendered).toContain('[other]\nvalue = true')
    expect(rendered).not.toContain('old.example')
  })

  it('rejects non-HTTPS relay endpoints', () => {
    expect(() => renderCodexRelayConfig({ existing: '', provider: 'damai_relay', model: 'model', baseUrl: 'http://relay.example/v1', apiKeyEnv: 'KEY' })).toThrow('HTTPS')
  })

  it('validates host relay separately from the business relay', () => {
    const config = renderCodexRelayConfig({ existing: '', provider: 'damai_relay', model: 'responses-model', baseUrl: 'https://host-relay.example/v1', apiKeyEnv: 'DAMAI_CODEX_RELAY_API_KEY' })
    expect(validateCodexRelay(config, {
      DAMAI_CODEX_RELAY_API_KEY: 'host-secret', MODEL_RELAY_BASE_URL: 'https://business-relay.example/v1', MODEL_RELAY_API_KEY: 'business-secret',
      AI_MODEL: 'text', IMAGE_MODEL: 'image', IMAGE_EDIT_MODEL: 'edit', OCR_MODEL: 'ocr', VIDEO_MODEL: 'video',
    }).errors).toEqual([])
  })

  it('accepts ChatGPT subscription authentication when no host override is configured', () => {
    const result = validateCodexRelay('approval_policy = "never"\n', {
      MODEL_RELAY_BASE_URL: 'https://business-relay.example/v1', MODEL_RELAY_API_KEY: 'business-secret',
      AI_MODEL: 'text', IMAGE_MODEL: 'image', IMAGE_EDIT_MODEL: 'edit', OCR_MODEL: 'ocr', VIDEO_MODEL: 'video',
    })
    expect(result.errors).toEqual([])
    expect(result.subscriptionAuth).toBe(true)
  })

  it('fails closed when host wire_api and env_key are absent', () => {
    const result = validateCodexRelay('model_provider = "bad"', {})
    expect(result.errors).toEqual(expect.arrayContaining([
      'Codex 配置缺少有效的 host model', 'Codex 配置缺少 model_providers.bad section',
      'Codex host relay 缺少有效的 base_url', 'Codex host relay 必须配置 wire_api = "responses"',
      'Codex host relay 缺少有效的 env_key（必须是环境变量名）', '业务模型 relay 缺少有效的 MODEL_RELAY_BASE_URL',
    ]))
  })

  it('fails closed when the relay is OpenAI-compatible but not compatible with the Codex App model catalog', async () => {
    const environment = {
      DAMAI_CODEX_RELAY_API_KEY: 'host-secret', MODEL_RELAY_BASE_URL: 'https://business-relay.example/v1', MODEL_RELAY_API_KEY: 'business-secret',
      AI_MODEL: 'text', IMAGE_MODEL: 'image', IMAGE_EDIT_MODEL: 'edit', OCR_MODEL: 'ocr', VIDEO_MODEL: 'video',
    }
    const config = renderCodexRelayConfig({ existing: '', provider: 'damai_relay', model: 'responses-model', baseUrl: 'https://host-relay.example/v1', apiKeyEnv: 'DAMAI_CODEX_RELAY_API_KEY' })
    const result = validateCodexRelay(config, environment)
    await probeCodexRelayCatalog(result, environment, async () => new Response(JSON.stringify({ object: 'list', data: [{ id: 'responses-model' }] })))
    expect(result.errors).toContain('Codex host relay /models 与当前 Codex App 目录契约不兼容：缺少顶层 models 数组')
  })

  it('accepts a catalog that declares the selected model in both supported directory shapes', async () => {
    const environment = {
      DAMAI_CODEX_RELAY_API_KEY: 'host-secret', MODEL_RELAY_BASE_URL: 'https://business-relay.example/v1', MODEL_RELAY_API_KEY: 'business-secret',
      AI_MODEL: 'text', IMAGE_MODEL: 'image', IMAGE_EDIT_MODEL: 'edit', OCR_MODEL: 'ocr', VIDEO_MODEL: 'video',
    }
    const config = renderCodexRelayConfig({ existing: '', provider: 'damai_relay', model: 'responses-model', baseUrl: 'https://host-relay.example/v1', apiKeyEnv: 'DAMAI_CODEX_RELAY_API_KEY' })
    const result = validateCodexRelay(config, environment)
    await probeCodexRelayCatalog(result, environment, async () => new Response(JSON.stringify({
      object: 'list',
      data: [{ id: 'responses-model', supported_endpoint_types: ['openai-response'] }],
      models: [{ slug: 'responses-model', context_window: 128_000 }],
    })))
    expect(result.errors).toEqual([])
  })

  it('rejects an id-only pseudo Codex catalog or a model without Responses routing', async () => {
    const environment = {
      DAMAI_CODEX_RELAY_API_KEY: 'host-secret', MODEL_RELAY_BASE_URL: 'https://business-relay.example/v1', MODEL_RELAY_API_KEY: 'business-secret',
      AI_MODEL: 'text', IMAGE_MODEL: 'image', IMAGE_EDIT_MODEL: 'edit', OCR_MODEL: 'ocr', VIDEO_MODEL: 'video',
    }
    const config = renderCodexRelayConfig({ existing: '', provider: 'damai_relay', model: 'responses-model', baseUrl: 'https://host-relay.example/v1', apiKeyEnv: 'DAMAI_CODEX_RELAY_API_KEY' })
    const result = validateCodexRelay(config, environment)
    await probeCodexRelayCatalog(result, environment, async () => new Response(JSON.stringify({
      object: 'list', data: [{ id: 'responses-model' }], models: [{ id: 'responses-model' }],
    })))
    expect(result.errors).toEqual(expect.arrayContaining([
      'Codex host relay 当前 host model 未声明 openai-response 能力：responses-model',
      'Codex host relay Codex models[] 未声明当前 host model slug：responses-model',
    ]))
  })
})
