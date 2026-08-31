import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
const script = readFileSync(new URL('../scripts/start-local-with-relay.sh', import.meta.url), 'utf8')
const compose = readFileSync(new URL('../infra/local/docker-compose.yml', import.meta.url), 'utf8')

describe('local relay start contract', () => {
  it('provides one rebuild command that cannot bypass the relay environment loader', () => {
    expect(packageJson.scripts['dev:stack:relay:build']).toBe('sh scripts/start-local-with-relay.sh --build api ui worker-generation')
    expect(packageJson.scripts['dev:stack:relay:build']).not.toContain('docker compose')
  })

  it('loads the protected launchctl key and exports all five business model contracts', () => {
    expect(script).toContain('launchctl getenv WORMHOLE_API_KEY')
    for (const name of ['MODEL_RELAY_BASE_URL', 'MODEL_RELAY_API_KEY', 'AI_MODEL', 'IMAGE_MODEL', 'IMAGE_EDIT_MODEL', 'IMAGE_RESPONSE_FORMAT', 'OCR_MODEL', 'VIDEO_MODEL', 'VIDEO_DURATION_SECONDS']) {
      expect(script).toContain(`export ${name}`)
    }
    expect(compose).toContain('MODEL_RELAY_BASE_URL: ${MODEL_RELAY_BASE_URL:-https://ai.wormholexyz.xyz/v1}')
    expect(compose).toContain('MODEL_RELAY_API_KEY: ${MODEL_RELAY_API_KEY:-}')
    expect(compose).toContain('AI_MODEL: ${AI_MODEL:-deepseek-v4-pro}')
    expect(compose).toContain('IMAGE_MODEL: ${IMAGE_MODEL:-qwen-image-3.0}')
    expect(compose).toContain('IMAGE_GENERATION_EXECUTION_MODE: ${IMAGE_GENERATION_EXECUTION_MODE:-durable}')
    expect(compose).toContain('IMAGE_STATUS_PATH: ${IMAGE_STATUS_PATH:-}')
    expect(compose).toContain('IMAGE_EDIT_MODEL: ${IMAGE_EDIT_MODEL:-qwen-image-3.0}')
    expect(compose).toContain('OCR_MODEL: ${OCR_MODEL:-qwen3-max}')
    expect(compose).toContain('VIDEO_MODEL: ${VIDEO_MODEL:-happyhorse-1.1-t2v}')
  })
})
