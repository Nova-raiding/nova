import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const validator = 'infra/scripts/validate-ecs-rendered-bridge-mode.mjs'
const runner = 'infra/scripts/deploy-verified-ecs-compose.sh'
const runtime = ['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']
const all = [...runtime, 'ui', 'ops-ui', 'payment-gateway', 'clamav', 'pilot-gateway']
const image = `fixture@sha256:${'a'.repeat(64)}`

function config(bridgeMode: string | null | undefined) {
  return { services: Object.fromEntries(all.map(name => [name, {
    image,
    environment: { BRIDGE_SCHEMA_COMPATIBILITY_MODE: bridgeMode, RUN_MIGRATIONS_ON_STARTUP: 'false' },
  }])) }
}

function validate(input: unknown, mode: 'YES' | 'NO') {
  return spawnSync(process.execPath, [validator], { encoding: 'utf8', input: JSON.stringify(input), env: { ...process.env, ECS_BRIDGE_CODE_ONLY: mode } })
}

describe('frozen ECS bridge-mode render gate', () => {
  it('accepts only prefix mode for B and rejects a missing or partial worker override', () => {
    expect(validate(config('prefix_242_or_244'), 'YES').status).toBe(0)
    expect(validate(config(''), 'YES').status).not.toBe(0)
    const missingWorker = config('prefix_242_or_244')
    delete (missingWorker.services['worker-scan'] as { environment?: unknown }).environment
    expect(validate(missingWorker, 'YES').status).not.toBe(0)
  })

  it('requires exact empty mode on every API and worker for ordinary C', () => {
    expect(validate(config(''), 'NO').status).toBe(0)
    for (const inherited of ['prefix_242_or_244', ' ', null, undefined]) {
      const result = validate(config(inherited), 'NO')
      expect(result.status, String(inherited)).not.toBe(0)
      expect(result.stderr).toContain('non-bridge release must clear schema compatibility mode')
    }
    for (const name of runtime) {
      const mixed = config('')
      mixed.services[name]!.environment.BRIDGE_SCHEMA_COMPATIBILITY_MODE = 'prefix_242_or_244'
      expect(validate(mixed, 'NO').status, name).not.toBe(0)
    }
  })

  it('runs against frozen Compose before journal capture and nonce consumption', () => {
    const source = readFileSync(runner, 'utf8')
    const gate = source.indexOf('validate-ecs-rendered-bridge-mode.mjs')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(source.indexOf('set -- capture --state'))
    expect(gate).toBeLessThan(source.indexOf('consume-production-evidence-nonce.sh'))
  })
})
