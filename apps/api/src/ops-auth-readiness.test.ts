import { describe, expect, it } from 'vitest'
import { productionReadinessDiagnostics } from './server.js'

describe('password-only Ops production identity readiness', () => {
  it('requires a distinct HTTPS Ops origin', () => {
    const base = {
      NODE_ENV: 'production',
      OPS_AUTH_MODE: 'password',
      MCP_INTEGRATION_MODE: 'local_stdio',
      MERCHANT_BEARER_HOSTNAME: 'merchant.example.com',
    }
    expect(productionReadinessDiagnostics(base).gates.identity?.reasons ?? []).toContain('public_ops_base_url_invalid')
    expect(productionReadinessDiagnostics({ ...base, PUBLIC_OPS_BASE_URL: 'http://ops.example.com/path' }).gates.identity?.reasons ?? []).toContain('public_ops_base_url_invalid')
    expect(productionReadinessDiagnostics({ ...base, PUBLIC_OPS_BASE_URL: 'https://merchant.example.com' }).gates.identity?.reasons ?? []).toContain('ops_and_merchant_hostnames_must_differ')
    expect(productionReadinessDiagnostics({ ...base, PUBLIC_OPS_BASE_URL: 'https://ops.example.com' }).gates.identity?.reasons ?? []).not.toContain('public_ops_base_url_invalid')
  })
})
