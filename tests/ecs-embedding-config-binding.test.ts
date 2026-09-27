import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = 'infra/scripts/validate-ecs-embedding-config-binding.rb'
const model = 'qwen3.7-text-embedding-flash'
const relay = 'https://ai.wormholexyz.xyz/v1'
const apiEnvironment = {
  KNOWLEDGE_VECTOR_INDEX_ENABLED: 'true', EMBEDDING_MODEL: model, EMBEDDING_DIMENSIONS: '1024', EMBEDDING_VERSION: 'v1',
  MODEL_RELAY_BASE_URL: relay, MODEL_RELAY_ALLOWED_HOSTS: 'ai.wormholexyz.xyz', MODEL_RELAY_API_KEY: 'redacted-test-token',
  MODEL_RELAY_PRICING_DERIVATION_ENABLED: 'true', MODEL_RELAY_PRICING_GROUP: 'VIP', MODEL_RELAY_EMBEDDING_PRICING_GROUP: 'VIP',
  MODEL_EMBEDDING_MAX_REQUEST_CNY: '0.10', MODEL_RELAY_EMBEDDING_COST_EVIDENCE: 'true',
}
const automationEnvironment = Object.fromEntries(Object.entries(apiEnvironment).filter(([key]) => !['MODEL_EMBEDDING_MAX_REQUEST_CNY', 'MODEL_RELAY_EMBEDDING_COST_EVIDENCE'].includes(key)))

function fixture(enabled = true) {
  const config = `knowledge_vector_index_enabled: ${enabled}\nmodel_relay_base_url: ${relay}\nembedding_model: ${model}\nembedding_dimensions: 1024\nembedding_max_request_cny: 0.10\n`
  const services = Object.fromEntries(['api', 'api-replica', 'worker-automation', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan'].map(name => [name, {
    environment: name === 'worker-automation' ? { ...automationEnvironment } : name === 'api' || name === 'api-replica' ? { ...apiEnvironment } : {},
  }]))
  if (!enabled) for (const name of ['api', 'api-replica', 'worker-automation']) services[name]!.environment.KNOWLEDGE_VECTOR_INDEX_ENABLED = 'false'
  return { config, compose: { services } }
}

function verify(input: ReturnType<typeof fixture>) {
  const directory = mkdtempSync(join(tmpdir(), 'ecs-embedding-binding-'))
  const config = join(directory, 'config.yml')
  const compose = join(directory, 'compose.json')
  writeFileSync(config, input.config)
  writeFileSync(compose, JSON.stringify(input.compose))
  const result = spawnSync('ruby', [script, config, compose], { encoding: 'utf8', cwd: process.cwd() })
  return { ...result, config, compose }
}

describe('ECS embedding config and rendered Compose binding', () => {
  it('accepts the same enabled candidate on both APIs and the automation worker', () => {
    const result = verify(fixture())
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('binding passed')
  })

  it('accepts an explicitly disabled candidate without demanding embedding credentials', () => {
    const candidate = fixture(false)
    for (const name of ['api', 'api-replica', 'worker-automation']) {
      candidate.compose.services[name]!.environment.MODEL_RELAY_API_KEY = ''
    }
    expect(verify(candidate).status).toBe(0)
  })

  it.each(['api', 'api-replica', 'worker-automation'])('blocks config false with %s runtime enabled', name => {
    const candidate = fixture(false)
    candidate.compose.services[name]!.environment.KNOWLEDGE_VECTOR_INDEX_ENABLED = 'true'
    const result = verify(candidate)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${name}.KNOWLEDGE_VECTOR_INDEX_ENABLED differs`)
  })

  it.each(['api', 'api-replica', 'worker-automation'])('blocks config true with %s runtime disabled', name => {
    const candidate = fixture()
    candidate.compose.services[name]!.environment.KNOWLEDGE_VECTOR_INDEX_ENABLED = 'false'
    expect(verify(candidate).status).toBe(1)
  })

  it.each(['api', 'api-replica', 'worker-automation'])('blocks %s model or dimension drift', name => {
    for (const [key, value] of [['EMBEDDING_MODEL', 'other-model'], ['EMBEDDING_DIMENSIONS', '1536']] as const) {
      const candidate = fixture()
      candidate.compose.services[name]!.environment[key] = value
      expect(verify(candidate).status).toBe(1)
    }
  })

  it.each(['api', 'api-replica'])('blocks %s budget or cost evidence drift', name => {
    for (const [key, value] of [['MODEL_EMBEDDING_MAX_REQUEST_CNY', '0.11'], ['MODEL_RELAY_EMBEDDING_COST_EVIDENCE', 'false']] as const) {
      const candidate = fixture()
      candidate.compose.services[name]!.environment[key] = value
      expect(verify(candidate).status).toBe(1)
    }
  })

  it('blocks relay and credential drift across all embedding runtime services', () => {
    for (const [name, key, value] of [
      ['api', 'MODEL_RELAY_BASE_URL', 'https://other.example/v1'],
      ['api-replica', 'MODEL_RELAY_API_KEY', 'different-redacted-test-token'],
      ['worker-automation', 'MODEL_RELAY_ALLOWED_HOSTS', 'other.example'],
      ['worker-automation', 'MODEL_RELAY_API_KEY', ''],
    ] as const) {
      const candidate = fixture()
      candidate.compose.services[name]!.environment[key] = value
      const result = verify(candidate)
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('redacted-test-token')
    }
  })

  it('rejects a coherently redirected relay and unavailable pricing fallback', () => {
    const redirected = fixture()
    redirected.config = redirected.config.replace(relay, 'https://attacker.example/v1')
    for (const name of ['api', 'api-replica', 'worker-automation']) {
      redirected.compose.services[name]!.environment.MODEL_RELAY_BASE_URL = 'https://attacker.example/v1'
      redirected.compose.services[name]!.environment.MODEL_RELAY_ALLOWED_HOSTS = 'attacker.example'
    }
    expect(verify(redirected).status).toBe(1)

    for (const [key, value] of [
      ['MODEL_RELAY_PRICING_DERIVATION_ENABLED', 'false'],
      ['MODEL_RELAY_PRICING_GROUP', ''],
      ['MODEL_RELAY_EMBEDDING_PRICING_GROUP', ''],
    ] as const) {
      const missing = fixture()
      missing.compose.services.api!.environment[key] = value
      missing.compose.services['api-replica']!.environment[key] = value
      expect(verify(missing).status).toBe(1)
    }
  })

  it('rejects embedding enabled on another worker and absent required services', () => {
    const candidate = fixture(false)
    candidate.compose.services['worker-sync']!.environment.KNOWLEDGE_VECTOR_INDEX_ENABLED = 'true'
    expect(verify(candidate).status).toBe(1)
    delete candidate.compose.services['worker-sync']
    expect(verify(candidate).status).toBe(1)
  })

  it('rejects duplicate YAML controls and invalid rendered Compose without echoing secrets', () => {
    const candidate = fixture(false)
    candidate.config += 'knowledge_vector_index_enabled: true\n'
    expect(verify(candidate).status).toBe(1)
    const clean = fixture()
    const result = verify(clean)
    writeFileSync(result.compose, '{invalid-json')
    const retry = spawnSync('ruby', [script, result.config, result.compose], { encoding: 'utf8', cwd: process.cwd() })
    expect(retry.status).toBe(1)
    expect(retry.stderr).not.toContain('redacted-test-token')
    expect(readFileSync(result.config, 'utf8')).toBe(clean.config)
  })

  it('passes Ruby syntax validation', () => {
    expect(execFileSync('ruby', ['-c', script], { encoding: 'utf8' })).toContain('Syntax OK')
  })
})
