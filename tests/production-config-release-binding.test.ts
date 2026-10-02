import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const validator = resolve('infra/scripts/validate-production-release-binding.rb')

describe('rendered production configuration release binding', () => {
  it('accepts the selected release and never prints configuration values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-release-binding-'))
    try {
      const config = join(directory, 'production.yaml')
      writeFileSync(config, 'configuration_status: REQUIRES_RUNTIME_RELEASE_VERIFICATION\nrelease_id: release-5ab5f03e\nmodel_relay_api_key_ref: ecs-protected-env:MODEL_RELAY_API_KEY\n')
      const result = spawnSync('ruby', [validator, config, 'release-5ab5f03e'], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      expect(`${result.stdout}${result.stderr}`).not.toContain('MODEL_RELAY_API_KEY')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('rejects a stale or missing release identity without exposing config contents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-release-binding-'))
    try {
      const stale = join(directory, 'stale.yaml')
      const missing = join(directory, 'missing.yaml')
      writeFileSync(stale, 'release_id: ecs-20260918-09775ff2\nmodel_relay_api_key_ref: ecs-protected-env:MODEL_RELAY_API_KEY\n')
      writeFileSync(missing, 'configuration_status: BLOCKED_UNTIL_REQUIRED_PRODUCTION_INPUTS\n')
      for (const config of [stale, missing]) {
        const result = spawnSync('ruby', [validator, config, 'release-5ab5f03e'], { encoding: 'utf8' })
        expect(result.status).not.toBe(0)
        expect(`${result.stdout}${result.stderr}`).not.toContain('MODEL_RELAY_API_KEY')
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
