import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const validator = 'infra/scripts/validate-production-database-url.mjs'

function validate(environmentName: 'DATABASE_URL' | 'OPS_DATABASE_URL', value: string) {
  return () => execFileSync('node', [validator, environmentName], {
    cwd: process.cwd(),
    env: { ...process.env, [environmentName]: value },
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

describe('production database URL gate', () => {
  it.each(['require', 'verify-ca', 'verify-full'])('accepts PostgreSQL TLS mode %s for tenant and Ops databases', (sslmode) => {
    expect(validate('DATABASE_URL', `postgresql://tenant@db.internal/merchant?sslmode=${sslmode}`)).not.toThrow()
    expect(validate('OPS_DATABASE_URL', `postgres://ops@ops-db.internal/merchant?sslmode=${sslmode}`)).not.toThrow()
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
})
