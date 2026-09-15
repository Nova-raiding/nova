import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const validator = 'infra/scripts/validate-production-database-url.mjs'

function validate(environmentName: 'DATABASE_URL' | 'OPS_DATABASE_URL' | 'ALERT_RECEIVER_DATABASE_URL', value: string) {
  return () => execFileSync('node', [validator, environmentName], {
    cwd: process.cwd(),
    env: { ...process.env, [environmentName]: value },
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

describe('production database URL gate', () => {
  it.each(['require', 'verify-ca', 'verify-full'])('accepts PostgreSQL TLS mode %s for tenant, Ops, and receiver databases', (sslmode) => {
    expect(validate('DATABASE_URL', `postgresql://tenant@db.internal/merchant?sslmode=${sslmode}`)).not.toThrow()
    expect(validate('OPS_DATABASE_URL', `postgres://ops@ops-db.internal/merchant?sslmode=${sslmode}`)).not.toThrow()
    expect(validate('ALERT_RECEIVER_DATABASE_URL', `postgres://receiver@receiver-db.internal/merchant?sslmode=${sslmode}`)).not.toThrow()
  })

  it.each([
    'postgresql://ops@ops-db.internal/merchant',
    'postgresql://ops@ops-db.internal/merchant?sslmode=disable',
    'postgresql://ops@ops-db.internal/merchant?sslmode=require&sslmode=disable',
    'https://ops-db.internal/merchant?sslmode=verify-full',
  ])('rejects an insecure or malformed Ops database URL: %s', (value) => {
    expect(validate('OPS_DATABASE_URL', value)).toThrow(/OPS_DATABASE_URL.*(?:TLS|postgres)/)
  })

  it.each([
    'postgresql://ops@localhost/merchant?sslmode=verify-full',
    'postgresql://ops@localhost./merchant?sslmode=verify-full',
    'postgresql://ops@db.localhost/merchant?sslmode=verify-full',
    'postgresql://ops@localhost.localdomain/merchant?sslmode=verify-full',
    'postgresql://ops@127.0.0.2/merchant?sslmode=verify-full',
    'postgresql://ops@2130706433/merchant?sslmode=verify-full',
    'postgresql://ops@[::1]/merchant?sslmode=verify-full',
    'postgresql://ops@[::ffff:127.0.0.1]/merchant?sslmode=verify-full',
    'postgresql://ops@0.0.0.0/merchant?sslmode=verify-full',
  ])('rejects a local Ops database endpoint after URL normalization: %s', (value) => {
    expect(validate('OPS_DATABASE_URL', value)).toThrow(/OPS_DATABASE_URL.*local/)
  })

  it('applies the same local-address rejection to the tenant database', () => {
    expect(validate('DATABASE_URL', 'postgresql://tenant@127.1/merchant?sslmode=require')).toThrow(/DATABASE_URL.*local/)
  })

  it('applies the same TLS and local-address rules to a projected receiver credential without exposing its value', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-receiver-db-url-'))
    const credential = join(directory, 'DATABASE_URL')
    writeFileSync(credential, 'postgresql://receiver@receiver-db.internal/merchant?sslmode=verify-full\n')
    expect(() => execFileSync('node', [validator, 'ALERT_RECEIVER_DATABASE_URL'], {
      cwd: process.cwd(), env: { ...process.env, ALERT_RECEIVER_DATABASE_URL: '', ALERT_RECEIVER_DATABASE_URL_FILE: credential }, stdio: 'pipe',
    })).not.toThrow()
    writeFileSync(credential, 'postgresql://receiver@127.0.0.8/merchant?sslmode=verify-full\n')
    expect(() => execFileSync('node', [validator, 'ALERT_RECEIVER_DATABASE_URL'], {
      cwd: process.cwd(), env: { ...process.env, ALERT_RECEIVER_DATABASE_URL: '', ALERT_RECEIVER_DATABASE_URL_FILE: credential }, stdio: 'pipe',
    })).toThrow(/ALERT_RECEIVER_DATABASE_URL.*local/)
  })

  it('rejects a receiver credential reused from the tenant or Ops runtime', () => {
    const receiver = 'postgresql://shared@db.internal/merchant?sslmode=verify-full'
    expect(() => execFileSync('node', [validator, 'ALERT_RECEIVER_DATABASE_URL'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: receiver, ALERT_RECEIVER_DATABASE_URL: receiver }, stdio: 'pipe',
    })).toThrow(/dedicated credential/)
  })

  it('rejects local-only credentials for projected receiver URLs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-receiver-local-token-'))
    const credential = join(directory, 'DATABASE_URL')
    writeFileSync(credential, 'postgresql://receiver:pilot-local-token@receiver-db.internal/merchant?sslmode=verify-full\n')
    expect(() => execFileSync('node', [validator, 'ALERT_RECEIVER_DATABASE_URL'], {
      cwd: process.cwd(), env: { ...process.env, ALERT_RECEIVER_DATABASE_URL: '', ALERT_RECEIVER_DATABASE_URL_FILE: credential }, stdio: 'pipe',
    })).toThrow(/local-only credential/)
  })
})
