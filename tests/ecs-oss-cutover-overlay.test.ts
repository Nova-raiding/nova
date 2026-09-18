import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type ComposeConfig = { services: Record<string, { environment?: Record<string, string> }> }

const cutoverEnvironment = {
  ASSET_STORAGE_BUCKET: 'codex-image-20260914',
  ASSET_STORAGE_REGION: 'cn-beijing',
  ASSET_STORAGE_ENDPOINT: 'https://s3.oss-cn-beijing.aliyuncs.com',
  ASSET_STORAGE_PREFIX: 'merchant-assets',
  ASSET_STORAGE_ECS_RAM_ROLE: 'StoreNovaEcsOssRole',
  ASSET_STORAGE_QUOTA_BYTES: '50000000000',
  OBJECT_STORAGE_VERSIONING: 'true',
  DATA_RETENTION_DAYS: '90',
  ASSET_QUARANTINE_RETENTION_DAYS: '7',
  ASSET_CLEAN_RETENTION_DAYS: '90',
  DELETION_REQUEST_GRACE_DAYS: '7',
  BACKUP_RETENTION_DAYS: '30',
  LIFECYCLE_POLICY_REF: 'oss://codex-image-20260914/lifecycle/store-nova-merchant-assets-retention',
}

const keys = [
  'ALLOW_LOCAL_DURABLE_OBJECT_STORAGE', 'ASSET_STORAGE_BUCKET', 'ASSET_STORAGE_REGION',
  'ASSET_STORAGE_ENDPOINT', 'ASSET_STORAGE_PREFIX', 'ASSET_STORAGE_FORCE_PATH_STYLE',
  'ASSET_STORAGE_SSE_MODE', 'ASSET_STORAGE_KMS_KEY_ID', 'ASSET_STORAGE_CREDENTIAL_PROVIDER',
  'ASSET_STORAGE_ECS_RAM_ROLE', 'ASSET_STORAGE_QUOTA_BYTES', 'OBJECT_STORAGE_VERSIONING',
  'DATA_RETENTION_DAYS', 'ASSET_QUARANTINE_RETENTION_DAYS', 'ASSET_CLEAN_RETENTION_DAYS',
  'DELETION_REQUEST_GRACE_DAYS', 'BACKUP_RETENTION_DAYS', 'LIFECYCLE_POLICY_REF',
] as const

function render(overrides: NodeJS.ProcessEnv = {}): ComposeConfig {
  return JSON.parse(execFileSync('docker', [
    'compose', '-f', 'infra/local/docker-compose.yml',
    '-f', 'infra/local/docker-compose.ecs-oss-cutover.yml',
    'config', '--format', 'json',
  ], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, ...cutoverEnvironment, ...overrides },
  })) as ComposeConfig
}

describe('ECS OSS cutover overlay', () => {
  it('contains only API services and the reviewed environment allow-list', () => {
    const source = readFileSync('infra/local/docker-compose.ecs-oss-cutover.yml', 'utf8')
    expect(source).not.toMatch(/(?:JD|TAOBAO|TMALL|PDD|XHS|DOUYIN|VAULT|PAYMENT)_/u)
    const services = render().services
    for (const key of keys) expect(services.api?.environment?.[key]).toBeDefined()
    // A base-only field surviving proves that the overlay merges the service
    // environment map instead of replacing the server-owned wiring.
    expect(services.api?.environment?.MODEL_RELAY_BASE_URL).toBeDefined()
  })

  it('keeps primary and replica byte-for-byte identical', () => {
    const services = render().services
    for (const key of keys) {
      expect(services['api-replica']?.environment?.[key], key).toBe(services.api?.environment?.[key])
    }
  })

  it('does not modify the independently managed alert configuration', () => {
    const source = readFileSync('infra/local/docker-compose.ecs-oss-cutover.yml', 'utf8')
    expect(source).not.toMatch(/(?:OPS_ALERT|ALERT_CHANNEL|ALERT_WEBHOOK)_/u)
  })

  it('uses only the canonical ECS RAM role credential contract', () => {
    const source = readFileSync('infra/local/docker-compose.ecs-oss-cutover.yml', 'utf8')
    expect(source).toContain('ASSET_STORAGE_CREDENTIAL_PROVIDER: aliyun_ecs_ram_role')
    expect(source).not.toContain('ASSET_STORAGE_CREDENTIAL_MODE')
  })

  it.each(['ASSET_STORAGE_BUCKET', 'ASSET_STORAGE_REGION', 'ASSET_STORAGE_ENDPOINT',
    'ASSET_STORAGE_ECS_RAM_ROLE', 'ASSET_STORAGE_QUOTA_BYTES', 'OBJECT_STORAGE_VERSIONING',
    'DATA_RETENTION_DAYS', 'ASSET_QUARANTINE_RETENTION_DAYS', 'ASSET_CLEAN_RETENTION_DAYS',
    'DELETION_REQUEST_GRACE_DAYS', 'BACKUP_RETENTION_DAYS', 'LIFECYCLE_POLICY_REF'])('fails closed when %s is absent', (key) => {
    expect(() => render({ [key]: '' })).toThrow(new RegExp(`${key}.*required`))
  })
})
