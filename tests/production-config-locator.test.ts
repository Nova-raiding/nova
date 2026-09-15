import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('production config locator safety', () => {
  it('keeps the locator separate from developer dotenv and never sources it', () => {
    const shell = readFileSync(resolve('infra/scripts/launch-preflight.sh'), 'utf8')
    expect(shell).toContain('IFS= read -r config_path')
    expect(shell).not.toMatch(/(?:source|\.)\s+.*\.env/)
    const doctor = readFileSync(resolve('scripts/dev-doctor.ts'), 'utf8')
    expect(doctor).toContain("resolve(root, '.env.production-config-path')")
    expect(doctor).toContain('BLOCKED_UNTIL_')
    expect(doctor).toContain("resolve(root, 'infra/scripts/validate-production-config.sh')")
  })

  it('honors explicit environment paths and fails closed when missing', () => {
    const result = spawnSync('sh', ['infra/scripts/launch-preflight.sh'], {
      encoding: 'utf8', env: { ...process.env, PRODUCTION_CONFIG_PATH: '/nonexistent/production-config.yaml' },
    })
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).not.toContain('launch preflight passed')
  })
})
