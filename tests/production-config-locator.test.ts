import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

  it('lets the standalone production config gate resolve the safe locator', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'production-gate-locator-'))
    try {
      mkdirSync(resolve(root, 'infra/scripts'), { recursive: true })
      const gate = readFileSync(resolve('infra/scripts/validate-production-config.sh'), 'utf8')
      writeFileSync(resolve(root, 'infra/scripts/validate-production-config.sh'), gate, { mode: 0o755 })
      writeFileSync(resolve(root, '.env.production-config-path'), 'private/rendered.yaml\n')
      mkdirSync(resolve(root, 'private'), { recursive: true })
      writeFileSync(resolve(root, 'private/rendered.yaml'), 'plugin_enabled: false\n')
      const result = spawnSync('sh', [resolve(root, 'infra/scripts/validate-production-config.sh')], {
        cwd: root, encoding: 'utf8', env: { ...process.env },
      })
      expect(result.status).not.toBe(2)
      expect(result.stderr).not.toContain('requires a rendered config path')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves locator paths without executing shell text and preserves argument precedence', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'production-locator-'))
    try {
      const scripts = resolve(root, 'infra/scripts')
      mkdirSync(scripts, { recursive: true })
      writeFileSync(resolve(scripts, 'launch-preflight.sh'), readFileSync(resolve('infra/scripts/launch-preflight.sh')))
      // Stop immediately after resolution: no local or external deploy runs.
      writeFileSync(resolve(scripts, 'validate-production-config.sh'), '#!/bin/sh\nprintf "%s\\n" "$1"\nexit 42\n')
      const env = { ...process.env }
      delete env.PRODUCTION_CONFIG_PATH
      delete env.SKIP_LOCAL_OPS_GATE
      const run = (args: string[] = [], explicit?: string) => spawnSync('sh', [resolve(scripts, 'launch-preflight.sh'), ...args], {
        cwd: tmpdir(), encoding: 'utf8', env: { ...env, ...(explicit === undefined ? {} : { PRODUCTION_CONFIG_PATH: explicit }) },
      })
      const locator = 'private config/$(exit 99).yaml'
      writeFileSync(resolve(root, '.env.production-config-path'), `${locator}\n`)
      const fallback = run()
      expect(fallback.status).toBe(42)
      expect(fallback.stdout).toContain(`${root}/${locator}`)
      expect(run([], '/explicit config.yaml').stdout).toContain('/explicit config.yaml')
      expect(run(['/argument config.yaml'], '/ignored.yaml').stdout).toContain('/argument config.yaml')
      writeFileSync(resolve(root, '.env.production-config-path'), '')
      expect(run().status).not.toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
