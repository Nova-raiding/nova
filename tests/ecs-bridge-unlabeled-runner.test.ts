import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const runner = 'infra/scripts/deploy-ecs-bridge-unlabeled.sh'
const validator = 'infra/scripts/validate-ecs-bridge-scoped-compose.mjs'
const names = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']
const image = `example.test/merchant-api@sha256:${'a'.repeat(64)}`

function compose(extraService = false) {
  const services = names.map(name => `  ${name}:\n    image: ${image}\n    environment:\n      BRIDGE_SCHEMA_COMPATIBILITY_MODE: prefix_242_or_244\n    networks:\n${name === 'api-replica' ? '      - default\n      - storenova-demo-e0' : '      - default'}`).join('\n')
  return `services:\n${services}${extraService ? `\n  pilot-gateway:\n    image: ${image}\n` : '\n'}networks:\n  default:\n    external: true\n    name: merchant-production_default\n  storenova-demo-e0:\n    external: true\n    name: storenova-demo-e0\n`
}

describe('signed seven-container B takeover runner', () => {
  it('keeps source, gateway, schema, nonce and old readiness gates before mutation', () => {
    const script = readFileSync(runner, 'utf8')
    expect(execFileSync('sh', ['-n', runner], { encoding: 'utf8' })).toBe('')
    expect(script.indexOf('installed protected helper is not the reviewed seven-container version')).toBeLessThan(script.indexOf('consume-production-evidence-nonce.sh'))
    expect(script.indexOf('verify-bridge-b-package.mjs')).toBeLessThan(script.indexOf('consume-production-evidence-nonce.sh'))
    expect(script.indexOf('B API failed livez/readyz')).toBeGreaterThan(script.indexOf('bridge-switch-unlabeled'))
    expect(script.indexOf('curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/readyz"')).toBeLessThan(script.indexOf('consume-production-evidence-nonce.sh'))
    expect(script.indexOf('--external-gateway-id "$ECS_EXTERNAL_GATEWAY_ID"')).toBeLessThan(script.indexOf('bridge-switch-unlabeled'))
    expect(script.indexOf('bridge-recover-unlabeled')).toBeLessThan(script.indexOf('trap rollback_on_failure EXIT'))
    expect(script.indexOf('trap rollback_on_failure EXIT')).toBeLessThan(script.indexOf('bridge-begin --state'))
    expect(script).toContain('bridge-finalize')
    expect(script).not.toContain('--remove-orphans')
    expect(script).not.toContain('docker compose -p merchant-production')
  })

  it('accepts only a seven-service immutable scoped Compose with exact reviewed runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-scoped-'))
    const full = join(dir, 'full.yml'), scoped = join(dir, 'scoped.yml')
    writeFileSync(full, compose())
    writeFileSync(scoped, compose())
    const run = () => spawnSync('node', [validator, full, scoped, 'bridgecandidate'], { encoding: 'utf8' })
    const accepted = run()
    expect(accepted.status, accepted.stderr).toBe(0)
    writeFileSync(scoped, compose(true))
    expect(run().stderr).toContain('exactly seven services')
    writeFileSync(scoped, compose().replace('prefix_242_or_244', 'off'))
    expect(run().stderr).toContain('differs from reviewed full service')
  })
})
