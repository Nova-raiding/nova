import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = 'infra/scripts/verify-oss-access.mjs'
const base = {
  NODE_ENV: 'production',
  ASSET_STORAGE_BUCKET: 'merchant',
  ASSET_STORAGE_REGION: 'cn-beijing',
  ASSET_STORAGE_ENDPOINT: 'https://s3.oss-cn-beijing.aliyuncs.com',
  ASSET_STORAGE_CREDENTIAL_PROVIDER: 'aliyun_ecs_ram_role',
  ASSET_STORAGE_ECS_RAM_ROLE: 'StoreNovaEcsOssRole',
}

function verify(overrides: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...base, ...overrides }
  for (const key of ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
    if (!(key in overrides)) delete env[key]
  }
  return spawnSync('node', [script], { env, encoding: 'utf8', timeout: 5_000 })
}

describe('OSS access preflight credential contract', () => {
  it('rejects static secrets when ECS RAM Role is selected, without printing them', () => {
    const secret = 'sensitive-key-123'
    const result = verify({ OSS_ACCESS_KEY_SECRET: secret })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('must not receive static')
    expect(result.stderr).not.toContain(secret)
  })

  it('rejects a missing role and insecure endpoint before contacting OSS', () => {
    expect(verify({ ASSET_STORAGE_ECS_RAM_ROLE: '' }).status).toBe(2)
    expect(verify({ ASSET_STORAGE_ENDPOINT: 'http://s3.example.test' }).status).toBe(2)
    expect(verify({ ASSET_STORAGE_ENDPOINT: 'https://user:pass@s3.example.test' }).status).toBe(2)
  })

  it('rejects static mode in production even when keys are present', () => {
    const result = verify({ ASSET_STORAGE_CREDENTIAL_PROVIDER: 'static', OSS_ACCESS_KEY_ID: 'id', OSS_ACCESS_KEY_SECRET: 'secret' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('production preflight requires aliyun_ecs_ram_role')
  })
})
