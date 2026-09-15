import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const valid = {
  services: {
    api: { environment: {
      NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs', LOCAL_COMPOSE: 'false',
      CONNECTOR_FIXTURE_MODE: 'false', MERCHANT_TEST_APPROVED_RATES: 'false',
      ALLOW_LOCAL_DURABLE_OBJECT_STORAGE: 'false',
      ASSET_STORAGE_CREDENTIAL_PROVIDER: 'aliyun_ecs_ram_role',
      OPS_ALERT_NOTIFICATIONS_ENABLED: 'false',
      ALERT_CHANNEL_SECRET_REF: '', OPS_ALERT_WEBHOOK_URL: '',
      OPS_ALERT_WEBHOOK_ALLOWED_HOSTS: '', OPS_ALERT_WEBHOOK_SECRET_FILE: '',
    } },
    'api-replica': { environment: {
      NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs', LOCAL_COMPOSE: 'false',
      CONNECTOR_FIXTURE_MODE: 'false', MERCHANT_TEST_APPROVED_RATES: 'false',
      ALLOW_LOCAL_DURABLE_OBJECT_STORAGE: 'false',
      ASSET_STORAGE_CREDENTIAL_PROVIDER: 'aliyun_ecs_ram_role',
      OPS_ALERT_NOTIFICATIONS_ENABLED: 'false',
      ALERT_CHANNEL_SECRET_REF: '', OPS_ALERT_WEBHOOK_URL: '',
      OPS_ALERT_WEBHOOK_ALLOWED_HOSTS: '', OPS_ALERT_WEBHOOK_SECRET_FILE: '',
    } },
    migrate: {
      entrypoint: ['/bin/sh', '-c', '/bin/sh /ops/apply-migrations.sh && /bin/sh /ops/verify-runtime-db-role.sh'],
      volumes: ['/migrations:/migrations:ro'],
    },
  },
}

function validate(value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-production-compose-'))
  const path = join(dir, 'rendered.json')
  writeFileSync(path, JSON.stringify(value))
  return execFileSync('node', ['infra/scripts/validate-ecs-production-compose.mjs', path], {
    cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe',
  })
}

describe('ECS production Compose contract', () => {
  it('accepts a production render without demo seeding', () => {
    expect(validate(valid)).toContain('contract passed')
  })

  it.each([
    ['NODE_ENV', 'development'],
    ['DEPLOYMENT_PROFILE', 'local_acceptance'],
    ['LOCAL_COMPOSE', 'true'],
    ['CONNECTOR_FIXTURE_MODE', 'true'],
    ['MERCHANT_TEST_APPROVED_RATES', 'true'],
    ['ALLOW_LOCAL_DURABLE_OBJECT_STORAGE', 'true'],
  ])('rejects an auth-hardening style %s=%s override', (key, value) => {
    const rendered = structuredClone(valid)
    ;(rendered.services.api.environment as Record<string, string>)[key] = value
    expect(() => validate(rendered)).toThrow(new RegExp(`api\\.${key}`))
  })

  it('rejects seed-demo in either the command or mounts', () => {
    const command = structuredClone(valid)
    command.services.migrate.entrypoint.push('&& psql -f /ops/seed-demo.sql')
    expect(() => validate(command)).toThrow(/must not execute seed-demo/)

    const mount = structuredClone(valid)
    mount.services.migrate.volumes.push('./seed-demo.sql:/ops/seed-demo.sql:ro')
    expect(() => validate(mount)).toThrow(/must not mount seed-demo/)
  })

  it('rejects Kubernetes credentials and any enabled alert wiring', () => {
    for (const [key, value] of [
      ['ASSET_STORAGE_CREDENTIAL_PROVIDER', 'aliyun_ack_rrsa'],
      ['OPS_ALERT_NOTIFICATIONS_ENABLED', 'true'],
      ['OPS_ALERT_WEBHOOK_URL', 'https://alerts.example.test/hook'],
      ['OPS_ALERT_WEBHOOK_SECRET_FILE', '/run/secrets/alert_receiver_hmac_secret'],
    ] as const) {
      const rendered = structuredClone(valid)
      ;(rendered.services.api.environment as Record<string, string>)[key] = value
      expect(() => validate(rendered)).toThrow(new RegExp(`api\\.${key}`))
    }
  })

  it('rejects alert secret mounts and an always-on alert receiver', () => {
    const mount = structuredClone(valid) as any
    mount.services.api.volumes = ['/host/alert_receiver_hmac_secret:/run/secrets/alert_receiver_hmac_secret:ro']
    expect(() => validate(mount)).toThrow(/must not mount alert receiver secrets/)

    const receiver = structuredClone(valid) as any
    receiver.services['alert-receiver'] = { profiles: [] }
    expect(() => validate(receiver)).toThrow(/isolated behind the alerts profile/)
  })
})
