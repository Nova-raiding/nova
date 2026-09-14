import { describe, expect, it } from 'vitest'
import { applyModelEnvironment, MODEL_ENV_NAMES, parseEnvFile } from '../scripts/start-api-launchagent.mjs'

describe('LaunchAgent API model environment', () => {
  it('loads only allowlisted non-secret relay settings and preserves existing values', () => {
    const target: Record<string, string | undefined> = { AI_MODEL: 'already-selected' }
    applyModelEnvironment(target, [
      'MODEL_RELAY_BASE_URL=https://relay.example/v1',
      'MODEL_RELAY_API_KEY=must-not-be-loaded',
      'MODEL_RELAY_PRICING_DERIVATION_ENABLED=true',
      'MODEL_RELAY_VIDEO_PRICING_OVERRIDES=\'{"video-model":0.25}\'',
      'MODEL_DAILY_CNY_LIMIT=5000',
      'MODEL_MAX_TASK_COST_CNY=2000',
      'MODEL_VIDEO_MAX_REQUEST_CNY=20',
      'AI_MODEL=replacement-model',
    ].join('\n'))

    expect(target).toMatchObject({
      AI_MODEL: 'already-selected',
      MODEL_RELAY_BASE_URL: 'https://relay.example/v1',
      MODEL_RELAY_PRICING_DERIVATION_ENABLED: 'true',
      MODEL_RELAY_VIDEO_PRICING_OVERRIDES: '{"video-model":0.25}',
      MODEL_DAILY_CNY_LIMIT: '5000',
      MODEL_MAX_TASK_COST_CNY: '2000',
      MODEL_VIDEO_MAX_REQUEST_CNY: '20',
    })
    expect(target.MODEL_RELAY_API_KEY).toBeUndefined()
    expect(MODEL_ENV_NAMES).not.toContain('MODEL_RELAY_API_KEY')
  })

  it('parses quoted values without executing shell syntax', () => {
    const values = parseEnvFile([
      'VIDEO_STATUS_PATH="/video/generations/{job_id}"',
      "MODEL_RELAY_PRICING_GROUP='VIP'",
      'IGNORED=$(touch /tmp/never-run)',
    ].join('\n'))

    expect(values.get('VIDEO_STATUS_PATH')).toBe('/video/generations/{job_id}')
    expect(values.get('MODEL_RELAY_PRICING_GROUP')).toBe('VIP')
    expect(values.get('IGNORED')).toBe('$(touch /tmp/never-run)')
  })
})
