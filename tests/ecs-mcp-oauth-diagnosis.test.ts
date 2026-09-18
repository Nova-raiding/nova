import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('ECS OAuth diagnosis', () => {
  it('fails closed for missing client registry without printing credentials', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-diagnosis-'))
    try {
      const docker = join(dir, 'docker')
      writeFileSync(docker, `#!/bin/sh
case "$1" in
  ps) echo 'api-1 store-nova-api:candidate' ;;
  inspect) printf '%s\\n' 'NODE_ENV=production' 'MCP_OAUTH_REQUIRED=true' 'SECRET_KEY=do-not-print' ;;
esac
`, { mode: 0o700 })
      const result = spawnSync('sh', ['infra/scripts/diagnose-ecs-mcp-oauth.sh'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` } })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('clients=missing')
      expect(result.stderr).toContain('api_oauth_config_missing_or_nonproduction')
      expect(result.stdout + result.stderr).not.toContain('do-not-print')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
